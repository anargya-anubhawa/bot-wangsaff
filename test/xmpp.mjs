/**
 * GX-ID — XMPP ↔ Minecraft bridge test
 *
 * Covers the whole feature without touching a network:
 *   • pure helpers (text detection, sanitisation, truncation, formatting, parsing)
 *   • the WhatsApp → Minecraft relay decision (the acceptance-test filters)
 *   • rate limiting (WhatsApp → Minecraft only)
 *   • the wired bridge (broadcast to bridge groups, echo/loop prevention)
 *   • the XMPP client lifecycle (status transitions, backoff, send, stanza parse)
 *   • the manager's database-backed bridge state
 *   • the `.xmpp` command registration
 */
import assert from "assert";
import path from "path";
import fs from "fs";
import { EventEmitter } from "events";

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
  }
}

/* ─────────────────────────── database (bridge state lives here) ─────────────────────────── */

const dbPath = path.join(process.cwd(), "database", "xmpp-test");
fs.rmSync(dbPath, { recursive: true, force: true });
const { initDatabase, getDatabase } = await import("../lib/database.js");
await initDatabase(dbPath);

const bridge = await import("../lib/xmpp/bridge.js");
const clientMod = await import("../lib/xmpp/client.js");
const manager = await import("../lib/xmpp/manager.js");
const xmppConfig = (await import("../config/xmpp.js")).default;
const { xml } = await import("@xmpp/client");

/* ─────────────────────────── fakes ─────────────────────────── */

function fakeSock() {
  const sent = [];
  return {
    sent,
    sendMessage: async (jid, content) => {
      sent.push({ jid, content });
      return { key: { id: `m${sent.length}` } };
    },
  };
}

function textMsg(body, { chat = "111@g.us", fromMe = false, type = "conversation", isMedia = false, isCommand = false, isGroup = true } = {}) {
  return {
    chat,
    body,
    fromMe,
    type,
    isMedia,
    isCommand,
    isGroup,
    sender: "628111@s.whatsapp.net",
    senderNumber: "628111",
    pushName: "Anargya",
    reply: async () => {},
  };
}

/* ═══════════════════════════ pure helpers ═══════════════════════════ */

await test("isTextMessage accepts only plain text", () => {
  assert.equal(bridge.isTextMessage({ type: "conversation" }), true);
  assert.equal(bridge.isTextMessage({ type: "extendedTextMessage" }), true);
  for (const type of ["imageMessage", "videoMessage", "audioMessage", "stickerMessage", "documentMessage", "locationMessage", "contactMessage", "pollCreationMessage", "reactionMessage"]) {
    assert.equal(bridge.isTextMessage({ type }), false, `${type} must not count as text`);
  }
  assert.equal(bridge.isTextMessage({ type: "conversation", isMedia: true }), false, "isMedia flag wins");
});

await test("sanitizeWhatsAppText strips markup and collapses whitespace", () => {
  assert.equal(bridge.sanitizeWhatsAppText("Halo *Steve* 😂"), "Halo Steve 😂");
  assert.equal(bridge.sanitizeWhatsAppText("_a_ ~b~"), "a b");
  assert.equal(bridge.sanitizeWhatsAppText("```code```"), "code");
  assert.equal(bridge.sanitizeWhatsAppText("`inline`"), "inline");
  assert.equal(bridge.sanitizeWhatsAppText("a\n\n  b"), "a b");
  assert.equal(bridge.sanitizeWhatsAppText("x\u200by"), "xy");
});

await test("truncate is safe and bounded", () => {
  assert.equal(bridge.truncate("abcdefghij", 6), "abcde…");
  assert.equal(bridge.truncate("short", 20), "short");
  assert.equal(bridge.truncate("anything", 0), "anything", "0 disables truncation");
  assert.ok(bridge.truncate("x".repeat(500), 240).length <= 240);
});

await test("formatMinecraftToWhatsApp matches the spec", () => {
  assert.equal(
    bridge.formatMinecraftToWhatsApp("Steve", "Halo guys"),
    "⛏️ Minecraft\n\nSteve: Halo guys",
  );
});

await test("formatWhatsAppToMinecraft matches the spec", () => {
  assert.equal(bridge.formatWhatsAppToMinecraft("Anargya", "Halo Steve!"), "[WA] Anargya: Halo Steve!");
});

await test("parseMinecraftMessage handles every inbound shape", () => {
  assert.deepEqual(
    (({ name, text }) => ({ name, text }))(bridge.parseMinecraftMessage({ from: "room@conf.host/Steve", body: "<Steve> Halo guys" })),
    { name: "Steve", text: "Halo guys" },
  );
  assert.deepEqual(
    (({ name, text }) => ({ name, text }))(bridge.parseMinecraftMessage({ from: "minecraft@host", body: "Steve: Halo" })),
    { name: "Steve", text: "Halo" },
  );
  assert.deepEqual(
    (({ name, text }) => ({ name, text }))(bridge.parseMinecraftMessage({ from: "room@conf.host/Alex", body: "Halo semua" })),
    { name: "Alex", text: "Halo semua" },
  );
});

/* ═══════════════════════════ relay decision (acceptance tests) ═══════════════════════════ */

const GROUPS = ["111@g.us", "222@g.us"];

await test("acceptance 2: bridge-group text is relayed", () => {
  const d = bridge.shouldRelayWhatsApp(textMsg("Halo Minecraft!"), { enabled: true, groups: GROUPS, config: xmppConfig });
  assert.equal(d.relay, true);
  assert.equal(d.text, "Halo Minecraft!");
});

await test("acceptance 3: another group is NOT relayed", () => {
  const d = bridge.shouldRelayWhatsApp(textMsg("Halo", { chat: "999@g.us" }), { enabled: true, groups: GROUPS, config: xmppConfig });
  assert.equal(d.relay, false);
});

await test("acceptance 4: private chat is NOT relayed", () => {
  const m = textMsg("Halo", { chat: "628111@s.whatsapp.net" });
  m.isGroup = false;
  const d = bridge.shouldRelayWhatsApp(m, { enabled: true, groups: GROUPS, config: xmppConfig });
  assert.equal(d.relay, false);
});

await test("acceptance 5/6/7: media (image/audio/sticker) is NOT relayed", () => {
  for (const type of ["imageMessage", "audioMessage", "stickerMessage", "videoMessage"]) {
    const d = bridge.shouldRelayWhatsApp(textMsg("caption", { type }), { enabled: true, groups: GROUPS, config: xmppConfig });
    assert.equal(d.relay, false, `${type} must not relay`);
  }
});

await test("acceptance 8: a bot command is NOT relayed", () => {
  const d = bridge.shouldRelayWhatsApp(textMsg("menu", { isCommand: true }), { enabled: true, groups: GROUPS, config: xmppConfig });
  assert.equal(d.relay, false);
});

await test("a `/`-prefixed message is NOT relayed", () => {
  const d = bridge.shouldRelayWhatsApp(textMsg("/menu"), { enabled: true, groups: GROUPS, config: xmppConfig });
  assert.equal(d.relay, false);
});

await test("bot's own message (fromMe) is NOT relayed", () => {
  const d = bridge.shouldRelayWhatsApp(textMsg("Halo", { fromMe: true }), { enabled: true, groups: GROUPS, config: xmppConfig });
  assert.equal(d.relay, false);
});

await test("disabled bridge relays nothing", () => {
  const d = bridge.shouldRelayWhatsApp(textMsg("Halo"), { enabled: false, groups: GROUPS, config: xmppConfig });
  assert.equal(d.relay, false);
});

/* ═══════════════════════════ rate limiting ═══════════════════════════ */

await test("RateLimiter enforces max per window", () => {
  const rl = new bridge.RateLimiter({ max: 3, windowMs: 5000 });
  assert.equal(rl.check("u", 1000).allowed, true);
  assert.equal(rl.check("u", 1100).allowed, true);
  assert.equal(rl.check("u", 1200).allowed, true);
  const blocked = rl.check("u", 1300);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterMs > 0);
  assert.equal(rl.check("u", 7000).allowed, true, "window slides");
  assert.equal(rl.check("other", 1300).allowed, true, "per-key isolation");
});

/* ═══════════════════════════ wired bridge ═══════════════════════════ */

await test("Minecraft → WhatsApp broadcasts to every bridge group only", async () => {
  const sock = fakeSock();
  const b = bridge.createBridge({
    config: xmppConfig,
    getSocket: () => sock,
    getBridgeState: () => ({ enabled: true, groups: GROUPS }),
    sendXmpp: async () => {},
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });
  const delivered = await b.handleMinecraftMessage({ from: "room@conf.host/Steve", body: "<Steve> Halo WhatsApp" });
  assert.equal(delivered, 2);
  assert.equal(sock.sent.length, 2);
  assert.equal(sock.sent[0].jid, "111@g.us");
  assert.equal(sock.sent[0].content.text, "⛏️ Minecraft\n\nSteve: Halo WhatsApp");
});

await test("WhatsApp → Minecraft sends once, sanitised and prefixed", async () => {
  const outbox = [];
  const b = bridge.createBridge({
    config: xmppConfig,
    getSocket: () => fakeSock(),
    getBridgeState: () => ({ enabled: true, groups: GROUPS }),
    sendXmpp: async (text) => outbox.push(text),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });
  const relayed = await b.relayWhatsAppToMinecraft(textMsg("Halo *Steve* 😂"));
  assert.equal(relayed, true);
  assert.deepEqual(outbox, ["[WA] Anargya: Halo Steve 😂"]);
});

await test("acceptance 10: Minecraft echo does NOT loop back to Minecraft", async () => {
  const outbox = [];
  const b = bridge.createBridge({
    config: xmppConfig,
    getSocket: () => fakeSock(),
    getBridgeState: () => ({ enabled: true, groups: GROUPS }),
    sendXmpp: async (text) => outbox.push(text),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });
  // WhatsApp → Minecraft
  await b.relayWhatsAppToMinecraft(textMsg("Hello"));
  assert.equal(outbox.length, 1);
  // The server echoes our own message back over XMPP — it must be dropped.
  const delivered = await b.handleMinecraftMessage({ from: `minecraft@host/${xmppConfig.nick}`, body: outbox[0] });
  assert.equal(delivered, 0, "echo must not be re-broadcast");
});

await test("our own MUC nickname is ignored on inbound", async () => {
  const sock = fakeSock();
  const b = bridge.createBridge({
    config: xmppConfig,
    getSocket: () => sock,
    getBridgeState: () => ({ enabled: true, groups: GROUPS }),
    sendXmpp: async () => {},
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });
  const delivered = await b.handleMinecraftMessage({ from: `room@conf.host/${xmppConfig.nick}`, body: "anything" });
  assert.equal(delivered, 0);
  assert.equal(sock.sent.length, 0);
});

await test("rate limit blocks the 4th WhatsApp message in the window", async () => {
  const outbox = [];
  const replies = [];
  const b = bridge.createBridge({
    config: { ...xmppConfig, rateLimit: { max: 3, windowMs: 5000 } },
    getSocket: () => fakeSock(),
    getBridgeState: () => ({ enabled: true, groups: GROUPS }),
    sendXmpp: async (text) => outbox.push(text),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });
  const mk = (body) => ({ ...textMsg(body), reply: async (t) => replies.push(t) });
  await b.relayWhatsAppToMinecraft(mk("1"));
  await b.relayWhatsAppToMinecraft(mk("2"));
  await b.relayWhatsAppToMinecraft(mk("3"));
  const fourth = await b.relayWhatsAppToMinecraft(mk("4"));
  assert.equal(fourth, false);
  assert.equal(outbox.length, 3);
  assert.ok(replies.some((r) => /Terlalu banyak pesan/.test(r)), "should warn the user");
});

await test("send failure surfaces the 'not connected' notice, never throws", async () => {
  const replies = [];
  const b = bridge.createBridge({
    config: xmppConfig,
    getSocket: () => fakeSock(),
    getBridgeState: () => ({ enabled: true, groups: GROUPS }),
    sendXmpp: async () => {
      throw new Error("XMPP not connected");
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });
  const relayed = await b.relayWhatsAppToMinecraft({ ...textMsg("Hi"), reply: async (t) => replies.push(t) });
  assert.equal(relayed, false);
  assert.ok(replies.some((r) => /tidak terhubung/.test(r)));
});

/* ═══════════════════════════ XMPP client lifecycle ═══════════════════════════ */

function fakeRawClient() {
  const raw = new EventEmitter();
  raw.sent = [];
  raw.startCalls = 0;
  raw.stopCalls = 0;
  raw.reconnect = { stop() {} };
  raw.start = async () => {
    raw.startCalls += 1;
    raw.emit("online");
  };
  raw.send = async (el) => {
    raw.sent.push(el);
  };
  raw.stop = async () => {
    raw.stopCalls += 1;
    raw.emit("offline");
  };
  return raw;
}

const clientCfg = {
  host: "xmpp.test",
  port: 7777,
  domain: "xmpp.test",
  username: "minecraft",
  password: "secret",
  resource: "gx-id",
  room: "",
  nick: "WhatsApp",
  to: "relay@xmpp.test",
  requireTls: false,
  reconnect: { minDelayMs: 5, maxDelayMs: 20 },
};

await test("client reaches AUTHENTICATED and logs Connected/Authenticated", async () => {
  const raw = fakeRawClient();
  const logs = [];
  const c = new clientMod.XmppClient(clientCfg, {
    factory: () => raw,
    logger: { info: (m) => logs.push(m), warn() {}, error() {} },
  });
  await c.connect();
  assert.equal(c.status, clientMod.XMPP_STATUS.AUTHENTICATED);
  assert.equal(c.isConnected, true);
  assert.ok(logs.some((l) => l.includes("Connecting to xmpp.test:7777")));
  assert.ok(logs.some((l) => l.includes("Connected")));
  assert.ok(logs.some((l) => l.includes("Authenticated")));
  await c.stop();
});

await test("client sends a body stanza to the configured target", async () => {
  const raw = fakeRawClient();
  const c = new clientMod.XmppClient(clientCfg, { factory: () => raw, logger: { info() {}, warn() {}, error() {} } });
  await c.connect();
  await c.send("[WA] Anargya: Halo");
  assert.equal(raw.sent.length, 1);
  const el = raw.sent[0];
  assert.equal(el.is("message"), true);
  assert.equal(el.attrs.to, "relay@xmpp.test");
  assert.equal(el.attrs.type, "chat");
  assert.equal(el.getChildText("body"), "[WA] Anargya: Halo");
  await c.stop();
});

await test("client emits parsed 'message' events and skips its own traffic", async () => {
  const raw = fakeRawClient();
  const c = new clientMod.XmppClient(clientCfg, { factory: () => raw, logger: { info() {}, warn() {}, error() {} } });
  await c.connect();
  const seen = [];
  c.on("message", (msg) => seen.push(msg));

  raw.emit("stanza", xml("message", { from: "room@conf.host/Steve", type: "groupchat" }, xml("body", {}, "<Steve> Hai")));
  raw.emit("stanza", xml("message", { from: "minecraft@xmpp.test/gx-id", type: "chat" }, xml("body", {}, "self")));
  raw.emit("stanza", xml("presence", { from: "x@y" }));

  assert.equal(seen.length, 1);
  assert.equal(seen[0].body, "<Steve> Hai");
  await c.stop();
});

await test("client reconnects with backoff after a disconnect", async () => {
  let created = 0;
  const raws = [];
  const c = new clientMod.XmppClient(clientCfg, {
    factory: () => {
      created += 1;
      const raw = fakeRawClient();
      raws.push(raw);
      return raw;
    },
    logger: { info() {}, warn() {}, error() {} },
  });
  await c.connect();
  assert.equal(created, 1);
  assert.equal(c.status, clientMod.XMPP_STATUS.AUTHENTICATED);

  raws[0].emit("offline");
  assert.equal(c.status, clientMod.XMPP_STATUS.RECONNECTING);

  await new Promise((r) => setTimeout(r, 60));
  assert.ok(created >= 2, "a new connection should be attempted");
  assert.equal(c.status, clientMod.XMPP_STATUS.AUTHENTICATED);
  await c.stop();
});

await test("client with no host reports ERROR without throwing", async () => {
  const c = new clientMod.XmppClient({ ...clientCfg, host: "" }, { factory: () => fakeRawClient(), logger: { info() {}, warn() {}, error() {} } });
  await c.connect();
  assert.equal(c.status, clientMod.XMPP_STATUS.ERROR);
});

/* ═══════════════════════════ manager bridge state (database-backed) ═══════════════════════════ */

await test("bridge state is stored in and read from the database", () => {
  const db = getDatabase();
  db.setting("xmppBridge", undefined);

  manager.seedBridgeState();
  assert.deepEqual(manager.getBridgeState().groups, [], "no seed groups configured → empty");

  manager.setBridgeEnabled(true);
  assert.equal(manager.getBridgeState().enabled, true);

  manager.addBridgeGroup("111@g.us");
  manager.addBridgeGroup("222@g.us");
  manager.addBridgeGroup("111@g.us"); // idempotent
  assert.deepEqual(manager.getBridgeGroups(), ["111@g.us", "222@g.us"]);

  manager.removeBridgeGroup("111@g.us");
  assert.deepEqual(manager.getBridgeGroups(), ["222@g.us"]);

  manager.setBridgeEnabled(false);
  assert.equal(manager.getBridgeState().enabled, false);
});

await test("getXmppStatus never leaks the password", () => {
  const status = manager.getXmppStatus();
  const dump = JSON.stringify(status);
  assert.ok(!dump.includes("password"), "no password key");
  assert.ok(!dump.includes(clientCfg.password), "no password value");
  for (const key of ["enabled", "groups", "status", "connected", "server", "account"]) {
    assert.ok(key in status, `missing ${key}`);
  }
});

await test("relay is a no-op before the bridge is started", async () => {
  const relayed = await manager.relayWhatsAppToMinecraft(textMsg("Halo"));
  assert.equal(relayed, false);
});

/* ═══════════════════════════ plugin registration ═══════════════════════════ */

const { loadPlugins, getPlugin } = await import("../lib/plugins.js");
{
  const silent = console.log;
  console.log = () => {};
  await loadPlugins(path.join(process.cwd(), "plugins"));
  console.log = silent;
}

await test(".xmpp command is registered under owner with an alias", () => {
  const p = getPlugin("xmpp");
  assert.ok(p, "xmpp plugin missing");
  assert.equal(p.config.category, "owner");
  assert.equal(typeof p.handler, "function");
  assert.ok(getPlugin("mc")?.config?.name === "xmpp", "mc alias broken");
});

/* ─────────────────────────── report ─────────────────────────── */

const passed = results.filter((r) => r.ok).length;
for (const r of results) {
  if (r.ok) console.log(`  ✔ ${r.name}`);
  else console.log(`  ✖ ${r.name}\n      ${r.error}`);
}
console.log(`\nxmpp: ${passed}/${results.length} passed`);
try {
  fs.writeFileSync(path.join(process.cwd(), "xmpp-report.json"), JSON.stringify(results, null, 2));
} catch {
  /* ignore */
}
fs.rmSync(dbPath, { recursive: true, force: true });
if (passed !== results.length) process.exit(1);
process.exit(0);
