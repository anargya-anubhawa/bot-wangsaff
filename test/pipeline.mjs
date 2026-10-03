/**
 * GX-ID — pipeline test
 *
 * Drives a raw message through serialize + messageHandler against a mock
 * socket to verify command dispatch, note lookup, permission gates and
 * cooldowns without a live WhatsApp connection.
 */
import assert from "assert";
import path from "path";
import fs from "fs";

const dbPath = path.join(process.cwd(), "database", "pipeline-test");
fs.rmSync(dbPath, { recursive: true, force: true });

const { initDatabase } = await import("../lib/database.js");
await initDatabase(dbPath);

const { loadPlugins } = await import("../lib/plugins.js");
await loadPlugins(path.join(process.cwd(), "plugins"));

const { messageHandler } = await import("../core/message.js");
const { extendSocket } = await import("../lib/socket.js");

function makeSock() {
  const sent = [];
  const sock = {
    user: { id: "628999:1@s.whatsapp.net", name: "GX-ID" },
    sendMessage: async (jid, content) => {
      sent.push({ jid, content });
      return { key: { id: `m${sent.length}` } };
    },
    relayMessage: async (jid, message, options) => {
      sent.push({ jid, relayed: message, options });
      return { key: { id: `r${sent.length}` } };
    },
    groupMetadata: async () => ({
      subject: "Test Group",
      participants: [
        { id: "628111@s.whatsapp.net", admin: null },
        { id: "628999:1@s.whatsapp.net", admin: "superadmin" },
      ],
      announce: false,
    }),
    sendPresenceUpdate: async () => {},
    profilePictureUrl: async () => null,
    waUploadToServer: {},
    store: { contacts: {} },
    updateMediaMessage: async () => {},
  };
  extendSocket(sock);
  return { sock, sent };
}

function rawMsg(body, { group = false, sender = null } = {}) {
  const from = sender || `6281${Math.floor(100000 + Math.random() * 899999)}@s.whatsapp.net`;
  return {
    key: {
      remoteJid: group ? "1234@g.us" : from,
      fromMe: false,
      id: `MSG${Math.random().toString(36).slice(2)}`,
      participant: group ? from : undefined,
    },
    message: { conversation: body },
    messageTimestamp: Math.floor(Date.now() / 1000),
    pushName: "Tester",
  };
}

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
  }
}

/* 1. plugin command dispatch (.ping) */
await test("dispatch .ping", async () => {
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".ping"), sock);
  assert.ok(sent.length > 0, "no message sent");
  const text = sent.find((s) => s.content?.text)?.content.text || "";
  assert.ok(text.includes("PONG"), `unexpected reply: ${text}`);
});

/* 2. alias dispatch (.m -> menu) */
await test("dispatch alias .m (menu)", async () => {
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".m"), sock);
  assert.ok(sent.length > 0, "no message sent");
  const interactive = sent.find((s) => s.relayed);
  const fallback = sent.find((s) => s.content?.image || s.content?.text);
  assert.ok(interactive || fallback, "menu produced no output");
});

/* 2b. interactive menu carries a messageSecret (WhatsApp drops it otherwise) */
await test("menu interactive carries messageSecret", async () => {
  const { sock, sent } = makeSock();
  // make prepareMedia succeed so the interactive path (not the fallback) is used
  sock.prepareMedia = async () => ({ imageMessage: { url: "https://example.com/x.jpg" } });
  await messageHandler(rawMsg(".menu"), sock);
  const relayed = sent.find((s) => s.relayed);
  assert.ok(relayed, "expected an interactive relayMessage send");
  const inner = relayed.relayed?.viewOnceMessage?.message;
  assert.ok(inner?.interactiveMessage, "missing interactiveMessage");
  const secret = inner?.messageContextInfo?.messageSecret;
  assert.ok(Buffer.isBuffer(secret) && secret.length === 32, "messageSecret must be 32-byte Buffer");
});

/* 2c. interactive menu carries the biz/native_flow nodes (WhatsApp drops it otherwise) */
await test("menu interactive carries biz native_flow nodes", async () => {
  const { sock, sent } = makeSock();
  sock.prepareMedia = async () => ({ imageMessage: { url: "https://example.com/x.jpg" } });
  await messageHandler(rawMsg(".menu"), sock);
  const relayed = sent.find((s) => s.relayed);
  assert.ok(relayed, "expected an interactive relayMessage send");
  const nodes = relayed.options?.additionalNodes;
  assert.ok(Array.isArray(nodes) && nodes.length > 0, "missing additionalNodes");
  const biz = nodes.find((n) => n.tag === "biz");
  assert.ok(biz, "missing biz node");
  const interactive = biz.content?.find((n) => n.tag === "interactive");
  assert.ok(interactive, "missing interactive node");
  assert.equal(interactive.attrs?.type, "native_flow", "interactive node must be native_flow");
  const nativeFlow = interactive.content?.find((n) => n.tag === "native_flow");
  assert.ok(nativeFlow, "missing native_flow node");
  const bot = nodes.find((n) => n.tag === "bot");
  assert.ok(bot, "private chat needs a bot node");
});

/* 3. unknown command -> suggestion */
await test("unknown command hint", async () => {
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".pign"), sock);
  const text = sent.find((s) => s.content?.text)?.content.text || "";
  assert.ok(text.includes("Unknown command") || text.toLowerCase().includes("unknown"), `got: ${text}`);
});

/* 4. note save + lookup */
await test("note save and #lookup", async () => {
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".addnote greeting hello world", { group: true }), sock);
  const savedText = sent.find((s) => s.content?.text)?.content.text || "";
  assert.ok(savedText.toLowerCase().includes("note"), `save reply: ${savedText}`);

  const { sock: sock2, sent: sent2 } = makeSock();
  await messageHandler(rawMsg("#greeting", { group: true }), sock2);
  const lookup = sent2.find((s) => s.content?.text)?.content.text || "";
  assert.equal(lookup, "hello world", `lookup reply: ${lookup}`);
});

/* 5. group-only command blocked in private */
await test("group-only command blocked in private", async () => {
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".tagall hi", { group: false }), sock);
  const text = sent.find((s) => s.content?.text)?.content.text || "";
  assert.ok(text.toLowerCase().includes("group"), `got: ${text}`);
});

/* 6. admin-only command blocked for non-admin */
await test("admin-only command blocked for non-admin", async () => {
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".tagall hi", { group: true, sender: "628222@s.whatsapp.net" }), sock);
  const text = sent.find((s) => s.content?.text)?.content.text || "";
  assert.ok(text.toLowerCase().includes("admin"), `got: ${text}`);
});

/* 7. admin command allowed for bot admin (bot is superadmin) */
await test("admin command allowed in group", async () => {
  const { sock, sent } = makeSock();
  // bot is superadmin; sender must be admin too for isAdmin. Use bot's own number as sender.
  await messageHandler(rawMsg(".tagall hello", { group: true, sender: "628999:1@s.whatsapp.net" }), sock);
  const text = sent.find((s) => s.content?.text)?.content.text || "";
  assert.ok(text.includes("MEMBERS") || text.includes("Message"), `got: ${text}`);
});

/* 8. owner-only command blocked for non-owner */
await test("owner-only blocked for non-owner", async () => {
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".mode self"), sock);
  const text = sent.find((s) => s.content?.text)?.content.text || "";
  assert.ok(text.toLowerCase().includes("owner"), `got: ${text}`);
});

/* 9. case system command (cping) */
await test("case command cping", async () => {
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".cping"), sock);
  const text = sent.find((s) => s.content?.text)?.content.text || "";
  assert.ok(text.includes("CASE SYSTEM PING") || text.includes("Latency"), `got: ${text}`);
});

/* 10. cooldown enforced */
await test("cooldown enforced", async () => {
  const sender = "628777000111@s.whatsapp.net";
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".ping", { sender }), sock);
  const { sock: sock2, sent: sent2 } = makeSock();
  await messageHandler(rawMsg(".ping", { sender }), sock2);
  const text = sent2.find((s) => s.content?.text)?.content.text || "";
  assert.ok(text.toLowerCase().includes("cooldown"), `got: ${text}`);
});

/* report */
for (const r of results) console.log(`${r.ok ? "✓" : "✗"} ${r.name}${r.ok ? "" : ` — ${r.error}`}`);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} pipeline checks passed`);
try {
  fs.writeFileSync(path.join(process.cwd(), "pipeline-report.json"), JSON.stringify(results, null, 2));
} catch {
  /* ignore */
}
fs.rmSync(dbPath, { recursive: true, force: true });
if (failed.length) process.exit(1);
process.exit(0);
