/**
 * GX-ID — control console test
 *
 * Verifies the separate-process control console: the in-bot `ControlServer`
 * (IPC socket) and the `ControlConsole` client that drives it, plus the pre-boot
 * menu timeout helper. A real loopback socket is used but with a fake socket and
 * database, so no WhatsApp connection is involved.
 */
import assert from "assert";
import net from "net";
import os from "os";
import path from "path";
import { PassThrough } from "stream";

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
  }
}

const { ControlServer } = await import("../lib/control-server.js");
const { ControlConsole } = await import("../lib/control-client.js");
const { collectGroups, formatDuration, formatMemory } = await import("../lib/control-utils.js");
const { ConsoleFrame, visibleLength, truncateAnsi } = await import("../lib/console-shared.js");
const { publishLog } = await import("../lib/log-bus.js");
const { publishIncoming } = await import("../lib/console-bus.js");
const { getMenuTimeout, DEFAULT_MENU_TIMEOUT, runBootInterface } = await import(
  "../lib/console-ui.js"
);

/* ─────────────────────────────── fakes ─────────────────────────────── */

function fakeDb() {
  return {
    listRegistrations: () => [
      { jid: "111@g.us", name: "Alpha", alias: "alpha", status: "active" },
    ],
    getGroup: (jid) => ({ "111@g.us": { name: "Alpha" } })[jid] || null,
    getAllGroups: () => ({
      "111@g.us": { name: "Alpha", registered: true },
      "222@g.us": { name: "Beta" },
    }),
  };
}

function fakeSock(sent) {
  return {
    sendText: async (jid, text) => {
      sent.push({ jid, text });
      return { ok: true };
    },
  };
}

/** A unique socket path per test to avoid collisions. */
let pathCounter = 0;
function uniquePath() {
  pathCounter += 1;
  if (process.platform === "win32") return `\\\\.\\pipe\\gx-id-test-${process.pid}-${pathCounter}`;
  return path.join(os.tmpdir(), `gx-id-test-${process.pid}-${pathCounter}.sock`);
}

async function makeServer(sent = [], extra = {}) {
  const server = new ControlServer({
    path: uniquePath(),
    getSocket: () => fakeSock(sent),
    getDb: () => fakeDb(),
    getUptime: () => 65_000,
    isConnected: () => true,
    ...extra,
  });
  await server.start(extra);
  return server;
}

/** Send one request to the server over a raw socket and await the reply. */
function rawRequest(server, request) {
  return new Promise((resolve, reject) => {
    
    const socket = net.connect(server.path);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (message.id === request.id) {
          socket.end();
          resolve(message);
          return;
        }
      }
    });
    socket.on("error", reject);
  });
}

/* ─────────────────────────────── tests ─────────────────────────────── */

await test("collectGroups lists registered groups first, then the rest", () => {
  const groups = collectGroups(fakeDb());
  assert.equal(groups.length, 2);
  assert.equal(groups[0].jid, "111@g.us");
  assert.equal(groups[0].registered, true);
  assert.equal(groups[0].alias, "alpha");
  assert.equal(groups[1].jid, "222@g.us");
  assert.equal(groups[1].registered, false);
});

await test("collectGroups tolerates a missing database", () => {
  assert.deepEqual(collectGroups(null), []);
});

await test("control server listens and reports status", async () => {
  const server = await makeServer();
  const reply = await rawRequest(server, { id: 1, type: "status" });
  assert.equal(reply.ok, true);
  assert.equal(reply.status.connected, true);
  assert.equal(reply.status.uptime, 65_000);
  assert.equal(reply.status.groups, 2);
  await server.stop();
});

await test("control server lists targets", async () => {
  const server = await makeServer();
  const reply = await rawRequest(server, { id: 1, type: "targets" });
  assert.equal(reply.targets.length, 2);
  assert.equal(reply.targets[0].jid, "111@g.us");
  await server.stop();
});

await test("control server sends a message to a chat", async () => {
  const sent = [];
  const server = await makeServer(sent);
  const reply = await rawRequest(server, { id: 1, type: "send", jid: "111@g.us", text: "hi" });
  assert.equal(reply.ok, true);
  assert.deepEqual(sent, [{ jid: "111@g.us", text: "hi" }]);
  await server.stop();
});

await test("control server broadcast to explicit jids", async () => {
  const sent = [];
  const server = await makeServer(sent);
  const reply = await rawRequest(server, {
    id: 1,
    type: "broadcast",
    jids: ["111@g.us", "222@g.us"],
    text: "pengumuman",
  });
  assert.equal(reply.ok, true);
  assert.equal(reply.sent, 2);
  assert.equal(sent.length, 2);
  await server.stop();
});

await test("control server broadcast defaults to registered groups only", async () => {
  const sent = [];
  const server = await makeServer(sent);
  const reply = await rawRequest(server, { id: 1, type: "broadcast", text: "hi" });
  assert.equal(reply.sent, 1);
  assert.deepEqual(sent, [{ jid: "111@g.us", text: "hi" }]);
  await server.stop();
});

await test("control server streams log lines to clients", async () => {
  const server = await makeServer();
  
  const socket = net.connect(server.path);
  socket.setEncoding("utf8");
  const received = [];
  const got = new Promise((resolve) => {
    socket.on("data", (chunk) => {
      for (const line of chunk.split("\n")) {
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (message.event === "log") {
          received.push(message.entry);
          resolve();
        }
      }
    });
  });
  await new Promise((r) => socket.once("connect", r));
  await new Promise((r) => setTimeout(r, 40));
  publishLog({ tag: "INFO", message: "hello from bot" });
  await got;
  assert.equal(received[0].message, "hello from bot");
  socket.end();
  await server.stop();
});

await test("control server streams incoming chat messages only when watching", async () => {
  const server = await makeServer();
  
  const socket = net.connect(server.path);
  socket.setEncoding("utf8");
  const incoming = [];
  socket.on("data", (chunk) => {
    for (const line of chunk.split("\n")) {
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.event === "incoming") incoming.push(message.message);
    }
  });
  await new Promise((r) => socket.once("connect", r));
  socket.write(`${JSON.stringify({ id: 1, type: "watch", jid: "111@g.us" })}\n`);
  await new Promise((r) => setTimeout(r, 40));

  publishIncoming({ chat: "222@g.us", sender: "x@s.whatsapp.net", body: "other", isGroup: true });
  publishIncoming({ chat: "111@g.us", sender: "y@s.whatsapp.net", body: "watched", isGroup: true });
  await new Promise((r) => setTimeout(r, 60));

  assert.equal(incoming.length, 1);
  assert.equal(incoming[0].body, "watched");
  socket.end();
  await server.stop();
});

await test("control server triggers restart/shutdown callbacks", async () => {
  let restarted = false;
  let stopped = false;
  const server = await makeServer([], {
    onRestart: async () => {
      restarted = true;
    },
    onShutdown: async () => {
      stopped = true;
    },
  });
  await rawRequest(server, { id: 1, type: "restart" });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(restarted, true);
  await rawRequest(server, { id: 2, type: "shutdown" });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(stopped, true);
  await server.stop();
});

/* ───────────────────────── console client over IPC ───────────────────────── */

/** Wait until the client is blocked on an input prompt. */
function waitForPrompt(client, maxMs = 3000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (client._pendingLine || Date.now() - started >= maxMs) {
        clearInterval(timer);
        resolve();
      }
    }, 10);
  });
}

/** Drive the client with fake streams against a real server. */
async function runClient({ server, steps }) {
  const input = new PassThrough();
  const output = new PassThrough();
  output.isTTY = true;
  output.rows = 24;
  output.columns = 120;
  let out = "";
  output.on("data", (c) => (out += c.toString()));

  const client = new ControlConsole({ input, output, path: server.path });
  await client.start();

  for (const step of steps) {
    await waitForPrompt(client);
    input.write(`${step}\n`);
    await new Promise((r) => setTimeout(r, 20));
  }
  // allow the final action's async work to flush
  await new Promise((r) => setTimeout(r, 250));

  client.stop();
  await new Promise((r) => setTimeout(r, 30));
  return { out };
}

await test("client sends a message to a group via the server", async () => {
  const sent = [];
  const server = await makeServer(sent);
  await runClient({ server, steps: ["1", "1", "hello there", "/back", "5"] });
  assert.deepEqual(sent, [{ jid: "111@g.us", text: "hello there" }]);
  await server.stop();
});

await test("client sends to a private chat with normalised number", async () => {
  const sent = [];
  const server = await makeServer(sent);
  await runClient({ server, steps: ["1", "p", "081234567890", "hai", "/back", "5"] });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].jid, "6281234567890@s.whatsapp.net");
  await server.stop();
});

await test("client broadcast-all reaches registered groups", async () => {
  const sent = [];
  const server = await makeServer(sent);
  await runClient({ server, steps: ["2", "1", "pengumuman", "", "5"] });
  assert.deepEqual(sent, [{ jid: "111@g.us", text: "pengumuman" }]);
  await server.stop();
});

await test("client shows the footer with clock, memory and menu", async () => {
  const server = await makeServer();
  const { out } = await runClient({ server, steps: ["5"] });
  assert.ok(/\d\d:\d\d:\d\d/.test(out), "clock shown");
  assert.ok(out.includes("[1]") && out.includes("[5]"), "menu shown");
  assert.ok(/🧠|👥|📶/.test(out), "status icons shown");
  await server.stop();
});

await test("client surfaces bot log lines above the footer", async () => {
  const server = await makeServer();
  const input = new PassThrough();
  const output = new PassThrough();
  output.isTTY = true;
  output.rows = 24;
  output.columns = 120;
  let out = "";
  output.on("data", (c) => (out += c.toString()));
  const client = new ControlConsole({ input, output, path: server.path });
  await client.start();
  await new Promise((r) => setTimeout(r, 60));
  publishLog({ tag: "COMMAND", message: ".menu from group" });
  await new Promise((r) => setTimeout(r, 60));
  client.stop();
  assert.ok(out.includes(".menu from group"), "log line should be rendered");
  await server.stop();
});

await test("client reports when the bot is not running", async () => {
  const output = new PassThrough();
  output.isTTY = true;
  let out = "";
  output.on("data", (c) => (out += c.toString()));
  const client = new ControlConsole({
    input: new PassThrough(),
    output,
    path: uniquePath(),
  });
  await client.start();
  assert.ok(out.includes("tidak bisa terhubung"), "should report a failed connection");
  client.stop();
});

/* ───────────────────────── live info formatting ───────────────────────── */

await test("formatDuration renders seconds, minutes and hours", () => {
  assert.equal(formatDuration(5000), "5s");
  assert.equal(formatDuration(65_000), "1m 05s");
  assert.equal(formatDuration(3_725_000), "1h 02m 05s");
});

await test("formatMemory renders MB with one decimal", () => {
  assert.equal(formatMemory(0), "0.0 MB");
  assert.equal(formatMemory(1024 * 1024 * 12.5), "12.5 MB");
});

await test("truncateAnsi keeps colour codes and respects visible width", () => {
  const coloured = `\x1b[36m${"x".repeat(20)}\x1b[39m`;
  const cut = truncateAnsi(coloured, 10);
  assert.ok(visibleLength(cut) <= 10, `visible length ${visibleLength(cut)}`);
  assert.ok(cut.includes("\x1b[36m"), "colour start kept");
  assert.ok(cut.includes("…"), "ellipsis appended");
});

/* ───────────────────────── persistent footer frame ───────────────────────── */

await test("ConsoleFrame reserves a scroll region and draws a fixed footer", () => {
  const output = new PassThrough();
  output.isTTY = true;
  output.rows = 24;
  output.columns = 80;
  let written = "";
  output.on("data", (c) => (written += c.toString()));

  const frame = new ConsoleFrame(output, { footer: ["STATUS", "MENU"] });
  frame.enter();
  assert.equal(frame.active, true);
  assert.equal(frame.footerHeight, 2);
  assert.equal(frame.promptRow, 22);
  assert.ok(written.includes("\x1b[1;22r"), "scroll region should end at row 22");
  assert.ok(written.includes("\x1b[23;1H"), "footer line 1 at row 23");
  assert.ok(written.includes("\x1b[24;1H"), "footer line 2 at row 24");

  written = "";
  frame.log("hello log");
  assert.ok(written.includes("hello log"), "log line written");
  assert.ok(written.startsWith("\x1b[22;1H"), "log written at the bottom of the scroll region");

  frame.setFooter(["STATUS", "NEW MENU", "EXTRA"]);
  assert.equal(frame.footerHeight, 3);
  assert.equal(frame.promptRow, 21);

  written = "";
  frame.leave();
  assert.equal(frame.active, false);
  assert.ok(written.includes("\x1b[r"), "scroll region reset on leave");
});

await test("ConsoleFrame falls back to plain writes without a TTY", () => {
  const output = new PassThrough();
  let written = "";
  output.on("data", (c) => (written += c.toString()));
  const frame = new ConsoleFrame(output, { footer: ["A"] });
  frame.enter();
  assert.equal(frame.active, false);
  frame.log("plain line");
  assert.equal(written, "plain line\n");
});

/* ───────────────────────── pre-boot menu timeout ───────────────────────── */

await test("DEFAULT_MENU_TIMEOUT is 30 seconds", () => {
  assert.equal(DEFAULT_MENU_TIMEOUT, 30);
});

await test("getMenuTimeout reads MENU_TIMEOUT and honours 0 = disabled", () => {
  const original = process.env.MENU_TIMEOUT;
  process.env.MENU_TIMEOUT = "45";
  assert.equal(getMenuTimeout(), 45);
  process.env.MENU_TIMEOUT = "0";
  assert.equal(getMenuTimeout(), 0);
  delete process.env.MENU_TIMEOUT;
  assert.equal(getMenuTimeout(), DEFAULT_MENU_TIMEOUT);
  process.env.MENU_TIMEOUT = "not-a-number";
  assert.equal(getMenuTimeout(), DEFAULT_MENU_TIMEOUT);
  if (original === undefined) delete process.env.MENU_TIMEOUT;
  else process.env.MENU_TIMEOUT = original;
});

await test("boot menu auto-starts after MENU_TIMEOUT seconds of inactivity", async () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  const output = new PassThrough();
  output.isTTY = true;

  const original = process.env.MENU_TIMEOUT;
  process.env.MENU_TIMEOUT = "1";

  const startedAt = Date.now();
  const action = await runBootInterface({ input, output });
  const elapsed = Date.now() - startedAt;

  if (original === undefined) delete process.env.MENU_TIMEOUT;
  else process.env.MENU_TIMEOUT = original;

  assert.equal(action, "start");
  assert.ok(elapsed >= 900, `should wait ~1s (waited ${elapsed}ms)`);
  assert.ok(elapsed < 5000, `should not hang (waited ${elapsed}ms)`);
});

await test("boot menu is skipped without a TTY", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const action = await runBootInterface({ input, output });
  assert.equal(action, "start");
});

/* ─────────────────────────────── report ─────────────────────────────── */

const passed = results.filter((r) => r.ok).length;
for (const r of results) {
  if (r.ok) console.log(`  ✔ ${r.name}`);
  else console.log(`  ✖ ${r.name}\n      ${r.error}`);
}
console.log(`\nconsole: ${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
