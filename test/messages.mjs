/**
 * GX-ID — feedback-message switch test
 *
 * Exercises `config.messages.enabled` / `onDisabled` through the real message
 * pipeline: with the switch on, gate notices are delivered as text; with it off
 * the bot either stays silent or reacts to the triggering message. Functional
 * command output must keep working either way.
 */
import assert from "assert";
import path from "path";
import fs from "fs";

const dbPath = path.join(process.cwd(), "database", "messages-test");
fs.rmSync(dbPath, { recursive: true, force: true });

const { initDatabase, getDatabase } = await import("../lib/database.js");
await initDatabase(dbPath);
const db = getDatabase();
db.setting("ownerNumbers", ["628000000001"]);

const { loadPlugins } = await import("../lib/plugins.js");
await loadPlugins(path.join(process.cwd(), "plugins"));

const { messageHandler } = await import("../core/message.js");
const { extendSocket } = await import("../lib/socket.js");
const config = (await import("../config.js")).default;
const { sendFeedback, sendFeedbackTo, feedbackEnabled, disabledMode } = await import("../lib/messages.js");

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
  }
}

const BOT = "628000000099@s.whatsapp.net";
const USER = "628000000004@s.whatsapp.net";

function makeSock() {
  const sent = [];
  const sock = {
    user: { id: BOT, name: "GX-ID" },
    sendMessage: async (jid, content, options) => {
      sent.push({ jid, content, options });
      return { key: { id: `m${sent.length}` } };
    },
    relayMessage: async (jid, message, options) => {
      sent.push({ jid, relayed: message, options });
      return { key: { id: `r${sent.length}` } };
    },
    groupMetadata: async () => ({
      subject: "Messages Test",
      participants: [{ id: BOT, admin: "superadmin" }],
      announce: false,
    }),
    sendPresenceUpdate: async () => {},
    profilePictureUrl: async () => null,
    prepareMedia: async () => ({ imageMessage: { url: "https://example.com/x.jpg" } }),
    waUploadToServer: {},
    store: { contacts: {} },
    updateMediaMessage: async () => {},
  };
  extendSocket(sock);
  return { sock, sent };
}

function rawMsg(body, { group = null, sender = USER } = {}) {
  return {
    key: { remoteJid: group === null ? sender : group, fromMe: false, id: `M${Math.random()}`, participant: group ? sender : undefined },
    message: { conversation: body },
    messageTimestamp: Math.floor(Date.now() / 1000),
    pushName: "Tester",
  };
}

const textsOf = (sent) => sent.filter((s) => s.content?.text).map((s) => s.content.text);
const reactionsOf = (sent) => sent.filter((s) => s.content?.react).map((s) => s.content.react.text);

/* Save/restore the switch around each test so order never matters. */
const saved = { enabled: config.messages.enabled, onDisabled: config.messages.onDisabled, react: config.messages.react };
function setSwitch({ enabled, onDisabled, react }) {
  if (enabled !== undefined) config.messages.enabled = enabled;
  if (onDisabled !== undefined) config.messages.onDisabled = onDisabled;
  if (react !== undefined) config.messages.react = react;
}

/* ═══════════════════════════ helpers ═══════════════════════════ */

await test("feedbackEnabled defaults to true", () => {
  setSwitch({ enabled: true });
  assert.equal(feedbackEnabled(), true);
});

await test("feedbackEnabled is false only when explicitly disabled", () => {
  setSwitch({ enabled: false });
  assert.equal(feedbackEnabled(), false);
  setSwitch({ enabled: true });
  assert.equal(feedbackEnabled(), true);
});

await test("disabledMode maps unknown values to silent", () => {
  setSwitch({ onDisabled: "react" });
  assert.equal(disabledMode(), "react");
  setSwitch({ onDisabled: "SILENT" });
  assert.equal(disabledMode(), "silent");
  setSwitch({ onDisabled: "nonsense" });
  assert.equal(disabledMode(), "silent");
});

await test("sendFeedback sends the text while enabled", async () => {
  setSwitch({ enabled: true });
  const replies = [];
  const m = { reply: async (t) => replies.push(t), react: async () => {} };
  assert.equal(await sendFeedback(m, "hello"), true);
  assert.deepEqual(replies, ["hello"]);
});

await test("sendFeedback does nothing for empty text while enabled", async () => {
  setSwitch({ enabled: true });
  const replies = [];
  const m = { reply: async (t) => replies.push(t), react: async () => {} };
  assert.equal(await sendFeedback(m, ""), false);
  assert.equal(replies.length, 0);
});

await test("sendFeedback goes silent when disabled + silent", async () => {
  setSwitch({ enabled: false, onDisabled: "silent" });
  const replies = [];
  const reactions = [];
  const m = { reply: async (t) => replies.push(t), react: async (e) => reactions.push(e) };
  assert.equal(await sendFeedback(m, "hello"), false);
  assert.equal(replies.length, 0);
  assert.equal(reactions.length, 0);
});

await test("sendFeedback reacts when disabled + react", async () => {
  setSwitch({ enabled: false, onDisabled: "react", react: "🔒" });
  const replies = [];
  const reactions = [];
  const m = { reply: async (t) => replies.push(t), react: async (e) => reactions.push(e) };
  assert.equal(await sendFeedback(m, "hello"), true);
  assert.equal(replies.length, 0);
  assert.deepEqual(reactions, ["🔒"]);
});

await test("sendFeedbackTo suppresses direct socket notices when disabled", async () => {
  const sent = [];
  const sock = { sendMessage: async (jid, content) => sent.push({ jid, content }) };
  setSwitch({ enabled: false });
  assert.equal(await sendFeedbackTo(sock, "x@s.whatsapp.net", "hi"), false);
  assert.equal(sent.length, 0);

  setSwitch({ enabled: true });
  assert.equal(await sendFeedbackTo(sock, "x@s.whatsapp.net", "hi"), true);
  assert.deepEqual(sent, [{ jid: "x@s.whatsapp.net", content: { text: "hi" } }]);
});

/* ═══════════════════════════ through the pipeline ═══════════════════════════ */

await test("enabled: an owner-only denial replies with the configured text", async () => {
  setSwitch({ enabled: true });
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".mode self"), sock);
  const texts = textsOf(sent);
  assert.ok(texts.some((t) => /owner/i.test(t)), `got: ${JSON.stringify(texts)}`);
});

await test("disabled + silent: a denied command sends nothing at all", async () => {
  setSwitch({ enabled: false, onDisabled: "silent" });
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".mode self"), sock);
  assert.equal(sent.length, 0, `expected no output, got ${JSON.stringify(textsOf(sent))}`);
});

await test("disabled + react: a denied command reacts and sends no text", async () => {
  setSwitch({ enabled: false, onDisabled: "react", react: "🔒" });
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".mode self"), sock);
  assert.equal(textsOf(sent).length, 0, "no text may be sent");
  assert.deepEqual(reactionsOf(sent), ["🔒"]);
});

await test("disabled + react: a group-only denial also reacts", async () => {
  setSwitch({ enabled: false, onDisabled: "react", react: "🚫" });
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".tagall hi"), sock); // group-only, used in private
  assert.equal(textsOf(sent).length, 0);
  assert.deepEqual(reactionsOf(sent), ["🚫"]);
});

await test("disabled: functional command output still works (.ping)", async () => {
  setSwitch({ enabled: false, onDisabled: "silent" });
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".ping"), sock);
  assert.ok(textsOf(sent).some((t) => t.includes("PONG")), `got: ${JSON.stringify(textsOf(sent))}`);
});

await test("disabled: an unknown command still hints (not a gate notice)", async () => {
  setSwitch({ enabled: false, onDisabled: "silent" });
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".pign"), sock);
  assert.ok(textsOf(sent).some((t) => /unknown/i.test(t)), `got: ${JSON.stringify(textsOf(sent))}`);
});

await test("disabled: a command error still reports (genericError is functional)", async () => {
  setSwitch({ enabled: false, onDisabled: "silent" });
  const te = (await import("../lib/error.js")).default;
  assert.ok(typeof te() === "string" && te().length > 0, "genericError must survive the switch");
});

/* ─────────────────────────── report ─────────────────────────── */

Object.assign(config.messages, saved);

for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name}${r.ok ? "" : ` — ${r.error}`}`);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} message-switch checks passed`);
fs.rmSync(dbPath, { recursive: true, force: true });
if (failed.length) process.exit(1);
process.exit(0);
