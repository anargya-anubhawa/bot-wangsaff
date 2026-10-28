/**
 * GX-ID — `.stats` (per-command usage statistics) test
 *
 * Verifies the global per-command usage counter end to end:
 *
 *   • the database API counts, sorts, totals and resets correctly;
 *   • a real command dispatched through the message pipeline is counted;
 *   • aliases fold into the command's canonical name (e.g. `.m` → `menu`);
 *   • `.stats` shows the top 10, `.stats all` shows everything, and the
 *     counters persist to `stats.json`.
 *
 * Uses the real message pipeline against a mock socket, so no WhatsApp
 * connection is involved.
 */
import assert from "assert";
import path from "path";
import fs from "fs";

const dbPath = path.join(process.cwd(), "database", "stats-test");
fs.rmSync(dbPath, { recursive: true, force: true });

const { initDatabase, getDatabase } = await import("../lib/database.js");
await initDatabase(dbPath);
const db = getDatabase();

const { loadPlugins, getPlugin, getConflicts, canonicalCommandName } = await import(
  "../lib/plugins.js"
);
await loadPlugins(path.join(process.cwd(), "plugins"));

const { messageHandler } = await import("../core/message.js");
const { extendSocket } = await import("../lib/socket.js");
const configModule = (await import("../config.js")).default;

if (configModule.features) configModule.features.antiSpam = false;
if (configModule.messages) configModule.messages.silent = false;
/* These suites assert on raw reply text, so switch OFF the reply transformer
   (super silent mode / auto-✅). test/messages.mjs covers it instead. */
if (configModule.messages) configModule.messages.transformEnabled = false;

const OWNER = "628000000001@s.whatsapp.net";
const USER = "628000000004@s.whatsapp.net";
const BOT = "628000000099@s.whatsapp.net";

// Register the owner in the DB so `.stats reset` (owner-only) is exercisable.
db.setting("ownerNumbers", ["628000000001"]);

const results = [];
async function test(name, fn) {
  try {
    // Clear per-user cooldowns so cross-test reuse of a sender never trips the
    // per-command cooldown (keyed by user+command, not chat).
    if (db.db?.data?.users) {
      for (const u of Object.values(db.db.data.users)) if (u) u.cooldowns = {};
    }
    await fn();
    results.push({ name, ok: true });
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
  }
}

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
    sendPresenceUpdate: async () => {},
    groupMetadata: async () => ({
      subject: "Stats Test Group",
      participants: [{ id: BOT, admin: "superadmin" }],
      announce: false,
    }),
    profilePictureUrl: async () => null,
    store: { contacts: {} },
  };
  extendSocket(sock);
  return { sock, sent };
}

function rawMsg(body, { group = "1000@g.us", sender = USER } = {}) {
  return {
    key: {
      remoteJid: group === null ? sender : group,
      fromMe: false,
      id: `MSG${Math.random().toString(36).slice(2)}`,
      participant: group ? sender : undefined,
    },
    message: { conversation: body },
    messageTimestamp: Math.floor(Date.now() / 1000),
    pushName: "Tester",
  };
}

function textOf(sent) {
  return sent.map((s) => s.content?.text || s.content?.caption || "").join("\n");
}

/* ─────────────────── 1. plugin registered, no conflicts ─────────────────── */

await test("the stats command is registered", () => {
  assert.ok(getPlugin("stats"), "stats plugin not registered");
  // `stats` itself must not introduce any NEW conflict (the registry's
  // pre-existing `serverinfo`/`pdfto`/`topdf` clashes are unrelated).
  const mine = getConflicts().filter((c) => c.name === "stats");
  assert.equal(mine.length, 0, `stats introduced a conflict: ${JSON.stringify(mine)}`);
});

/* ─────────────────── 2. database API ─────────────────── */

await test("database counts, sorts, totals and reports per command", () => {
  db.resetCommandStats();
  for (let i = 0; i < 100; i += 1) db.incrementCommandStat("menu");
  for (let i = 0; i < 20; i += 1) db.incrementCommandStat("asahotak");
  for (let i = 0; i < 7; i += 1) db.incrementCommandStat("ping");

  assert.equal(db.getCommandStat("menu"), 100);
  assert.equal(db.getCommandStat("never-used"), 0);
  assert.equal(db.getCommandStatCount(), 3);
  assert.equal(db.getTotalCommandUsage(), 127);

  const top = db.getTopCommands(10);
  assert.deepEqual(
    top.map((e) => [e.name, e.count]),
    [
      ["menu", 100],
      ["asahotak", 20],
      ["ping", 7],
    ],
  );

  // `limit = 0` means "everything"
  assert.equal(db.getTopCommands(0).length, 3);
  assert.equal(db.getTopCommands(2).length, 2, "limit must cap the list");
});

await test("resetCommandStats wipes every counter", () => {
  const removed = db.resetCommandStats();
  assert.equal(removed, 3);
  assert.equal(db.getCommandStatCount(), 0);
  assert.equal(db.getTotalCommandUsage(), 0);
  assert.deepEqual(db.getTopCommands(10), []);
});

await test("alias resolves to the canonical command name", () => {
  assert.equal(canonicalCommandName("m"), "menu");
  assert.equal(canonicalCommandName("menu"), "menu");
  assert.equal(canonicalCommandName("does-not-exist"), "does-not-exist");
});

/* ─────────────────── 3. real pipeline dispatch ─────────────────── */

await test("a dispatched command is counted under its canonical name", async () => {
  db.resetCommandStats();
  const { sock } = makeSock();
  // `.m` is an alias of `.menu`; it must fold into `menu`.
  await messageHandler(rawMsg(".m", { sender: USER, group: null }), sock);
  assert.equal(db.getCommandStat("menu"), 1, "menu should be counted once");
  assert.equal(db.getCommandStat("m"), 0, "aliases must not get their own bucket");
});

await test("an unknown command is NOT counted", async () => {
  db.resetCommandStats();
  const { sock } = makeSock();
  await messageHandler(rawMsg(".definitelynotacommand", { sender: USER, group: null }), sock);
  assert.equal(db.getCommandStatCount(), 0, "unknown commands must not be counted");
});

/* ─────────────────── 4. `.stats` rendering ─────────────────── */

await test(".stats shows the top commands (default view)", async () => {
  db.resetCommandStats();
  for (let i = 0; i < 100; i += 1) db.incrementCommandStat("menu");
  for (let i = 0; i < 20; i += 1) db.incrementCommandStat("asahotak");

  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".stats", { sender: USER, group: null }), sock);
  const text = textOf(sent);
  assert.ok(text.includes("STATISTIK COMMAND"), `got: ${text}`);
  assert.ok(text.includes("`.menu`") && text.includes("100"), `missing menu: ${text}`);
  assert.ok(text.includes("`.asahotak`") && text.includes("20"), `missing asahotak: ${text}`);
  assert.ok(text.includes(".stats all"), `expected an "all" hint: ${text}`);
});

await test(".stats all lists every tracked command", async () => {
  db.resetCommandStats();
  const names = ["menu", "asahotak", "ping", "sticker", "profile", "help"];
  names.forEach((n, i) => {
    for (let k = 0; k <= i; k += 1) db.incrementCommandStat(n);
  });

  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".stats all", { sender: USER, group: null }), sock);
  const text = textOf(sent);
  for (const n of names) {
    assert.ok(text.includes(`\`.${n}\``), `missing ${n}: ${text}`);
  }
  assert.ok(text.includes("*semua*"), `expected the "semua" marker: ${text}`);
});

await test(".stats reset is owner-only", async () => {
  db.resetCommandStats();
  for (let i = 0; i < 5; i += 1) db.incrementCommandStat("ping");

  // plain user → refused, counters untouched
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".stats reset", { sender: USER, group: null }), sock);
  assert.ok(textOf(sent).toLowerCase().includes("owner"), `got: ${textOf(sent)}`);
  assert.equal(db.getCommandStat("ping"), 5, "plain user must not reset");

  // owner → cleared
  const { sock: sock2 } = makeSock();
  await messageHandler(rawMsg(".stats reset", { sender: OWNER, group: null }), sock2);
  assert.equal(db.getCommandStatCount(), 0, "owner reset should clear the counters");
});

await test(".stats help renders the usage card", async () => {
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".stats help", { sender: USER, group: null }), sock);
  const text = textOf(sent);
  assert.ok(text.includes("Parameter tersedia"), `got: ${text}`);
  assert.ok(text.includes("all"), `got: ${text}`);
});

/* ─────────────────── 5. persistence ─────────────────── */

await test("command stats persist to stats.json", async () => {
  db.resetCommandStats();
  for (let i = 0; i < 42; i += 1) db.incrementCommandStat("menu");
  await db.save();

  const raw = fs.readFileSync(path.join(dbPath, "stats.json"), "utf8");
  const parsed = JSON.parse(raw);
  assert.equal(parsed.commands?.menu, 42, `stats.json missing the counter: ${raw}`);
});

/* ─────────────────── report ─────────────────── */

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "✓" : "✗"} ${r.name}${r.ok ? "" : ` — ${r.error}`}`);
console.log(`\n${results.length - failed.length}/${results.length} stats checks passed`);

try {
  fs.writeFileSync(
    path.join(process.cwd(), "stats-report.json"),
    JSON.stringify(results, null, 2),
  );
} catch {
  /* ignore */
}
fs.rmSync(dbPath, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
