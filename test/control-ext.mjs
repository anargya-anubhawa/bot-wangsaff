/**
 * GX-ID — extended control command tests
 *
 * Exercises the control-ext handlers through the real ControlServer socket, using
 * a fake socket and an in-memory database so no WhatsApp connection is involved.
 */
import assert from "assert";
import net from "net";
import os from "os";
import path from "path";

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

/* ─────────────────────────────── fakes ─────────────────────────────── */

function fakeDb() {
  const settings = { regMode: "open", bulkDelayMin: 500 };
  const schedules = {};
  const stats = { commandsUsed: 42 };
  const state = { whitelistEnabled: false };
  return {
    listRegistrations: () => [{ jid: "111@g.us", name: "Alpha", alias: "alpha", status: "active" }],
    getAllGroups: () => ({ "111@g.us": { name: "Alpha", registered: true } }),
    getSettings: () => ({ ...settings }),
    setting: (key, value = undefined) => {
      if (value !== undefined) settings[key] = value;
      return settings[key];
    },
    listWhitelist: () => [],
    addWhitelist: () => true,
    removeWhitelist: () => true,
    createSchedule: (id, data) => {
      schedules[id] = { id, active: true, ...data };
      return schedules[id];
    },
    listSchedules: () => Object.values(schedules),
    deleteSchedule: (id) => {
      const ok = Boolean(schedules[id]);
      delete schedules[id];
      return ok;
    },
    getTopCommands: (n) => [{ name: "menu", count: 10 }].slice(0, n),
    getTotalCommandUsage: () => 42,
    getCommandStatCount: () => 1,
    getStats: () => stats,
    eventLogCount: () => 0,
    _state: state,
  };
}

function fakeSock(calls) {
  return {
    sendText: async (jid, text) => {
      calls.push({ op: "text", jid, text });
      return { ok: true };
    },
    sendMedia: async (jid, source, caption, quoted, opts) => {
      calls.push({ op: "media", jid, caption, opts });
      return { ok: true };
    },
    sendPresenceUpdate: async (state, jid) => {
      calls.push({ op: "presence", state, jid });
    },
  };
}

let pathCounter = 0;
function uniquePath() {
  pathCounter += 1;
  if (process.platform === "win32") return `\\\\.\\pipe\\gx-id-ext-${process.pid}-${pathCounter}`;
  return path.join(os.tmpdir(), `gx-id-ext-${process.pid}-${pathCounter}.sock`);
}

async function makeServer(calls = []) {
  const db = fakeDb();
  const server = new ControlServer({
    path: uniquePath(),
    getSocket: () => fakeSock(calls),
    getDb: () => db,
    getUptime: () => 1_000,
    isConnected: () => true,
  });
  await server.start({});
  return server;
}

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

await test("settings-get returns sanitized settings", async () => {
  const server = await makeServer();
  const reply = await rawRequest(server, { id: 1, type: "settings-get" });
  assert.equal(reply.ok, true);
  assert.equal(reply.settings.regMode, "open");
  await server.stop();
});

await test("settings-set applies allowed keys and rejects ownerNumbers", async () => {
  const server = await makeServer();
  const ok = await rawRequest(server, { id: 2, type: "settings-set", settings: { bulkDelayMin: 900 } });
  assert.equal(ok.ok, true);
  assert.equal(ok.applied.bulkDelayMin, 900);
  const denied = await rawRequest(server, {
    id: 3, type: "settings-set", settings: { ownerNumbers: ["1"] },
  });
  assert.equal(denied.ok, false);
  await server.stop();
});

await test("owner-add / owner-list manage extra owners", async () => {
  const server = await makeServer();
  const added = await rawRequest(server, { id: 4, type: "owner-add", number: "6281234567890" });
  assert.equal(added.ok, true);
  assert.ok(added.owners.includes("6281234567890"));
  const list = await rawRequest(server, { id: 5, type: "owner-list" });
  assert.ok(list.owners.includes("6281234567890"));
  const removed = await rawRequest(server, { id: 6, type: "owner-remove", number: "6281234567890" });
  assert.ok(!removed.owners.includes("6281234567890"));
  await server.stop();
});

await test("schedule-add / list / delete round trip", async () => {
  const server = await makeServer();
  const added = await rawRequest(server, {
    id: 7, type: "schedule-add", jid: "111@g.us", content: "hi",
    sendTime: "08:00", recurrence: "daily",
  });
  assert.equal(added.ok, true);
  const id = added.schedule.id;
  const list = await rawRequest(server, { id: 8, type: "schedule-list" });
  assert.equal(list.schedules.length, 1);
  const del = await rawRequest(server, { id: 9, type: "schedule-delete", id });
  assert.equal(del.ok, true);
  await server.stop();
});

await test("schedule-add rejects bad time format", async () => {
  const server = await makeServer();
  const reply = await rawRequest(server, {
    id: 10, type: "schedule-add", jid: "111@g.us", content: "x", sendTime: "8am", recurrence: "daily",
  });
  assert.equal(reply.ok, false);
  await server.stop();
});

await test("media requires base64 or url", async () => {
  const server = await makeServer();
  const reply = await rawRequest(server, { id: 11, type: "media", jid: "111@g.us" });
  assert.equal(reply.ok, false);
  await server.stop();
});

await test("media base64 sends through the socket", async () => {
  const calls = [];
  const server = await makeServer(calls);
  const reply = await rawRequest(server, {
    id: 12, type: "media", jid: "111@g.us", base64: Buffer.from("hi").toString("base64"),
    mediaType: "image", caption: "test",
  });
  assert.equal(reply.ok, true);
  assert.equal(calls[0].op, "media");
  assert.equal(calls[0].caption, "test");
  await server.stop();
});

await test("presence rejects invalid state", async () => {
  const server = await makeServer();
  const reply = await rawRequest(server, { id: 13, type: "presence", state: "dancing" });
  assert.equal(reply.ok, false);
  await server.stop();
});

await test("stats returns top commands", async () => {
  const server = await makeServer();
  const reply = await rawRequest(server, { id: 14, type: "stats" });
  assert.equal(reply.ok, true);
  assert.equal(reply.stats.topCommands[0].name, "menu");
  await server.stop();
});

await test("unknown command still reports unknown", async () => {
  const server = await makeServer();
  const reply = await rawRequest(server, { id: 15, type: "definitely-not-a-command" });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /unknown request/);
  await server.stop();
});

/* ─────────────────────────────── report ─────────────────────────────── */

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.ok ? "" : `: ${r.error}`}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
