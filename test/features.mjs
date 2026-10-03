/**
 * GX-ID — feature test
 *
 * Exercises the new group/security/filter/schedule/config/level features
 * through the real message pipeline against a mock socket, across every
 * permission tier (owner / whitelist / group-admin / user) and validates the
 * two-stage `.kickall` confirmation, moderation deletion, filter auto-reply,
 * persistent schedules, timezone validation and the no-secret guarantees.
 */
import assert from "assert";
import path from "path";
import fs from "fs";
import os from "os";

const dbPath = path.join(process.cwd(), "database", "features-test");
fs.rmSync(dbPath, { recursive: true, force: true });

const { initDatabase, getDatabase } = await import("../lib/database.js");
await initDatabase(dbPath);
const db = getDatabase();

/* owner + whitelist configured in the DB (access.js reads these) */
db.setting("ownerNumbers", ["628000000001"]);
db.addWhitelist("628000000002", "test");

const { loadPlugins, getPlugin, getConflicts } = await import("../lib/plugins.js");
await loadPlugins(path.join(process.cwd(), "plugins"));

const { messageHandler } = await import("../core/message.js");
const { extendSocket } = await import("../lib/socket.js");
const configModule = (await import("../config.js")).default;

/* This suite drives many messages from a few senders in quick succession;
   GX-ID's anti-spam gate (8 msgs / 5s per sender) would otherwise swallow
   legitimate test traffic, so turn it off for the run only. */
if (configModule.features) configModule.features.antiSpam = false;

const OWNER = "628000000001@s.whatsapp.net";
const WHITELIST = "628000000002@s.whatsapp.net";
const ADMIN = "628000000003@s.whatsapp.net";
const ADMIN2 = "628000000005@s.whatsapp.net";
const USER = "628000000004@s.whatsapp.net";
const BOT = "628000000099@s.whatsapp.net";

function makeSock() {
  const sent = [];
  const calls = [];
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
      subject: "Feature Test Group",
      participants: [
        { id: BOT, admin: "superadmin" },
        { id: ADMIN, admin: "admin" },
        { id: ADMIN2, admin: "admin" },
        { id: USER, admin: null },
      ],
      announce: false,
    }),
    groupParticipantsUpdate: async (jid, jids, action) => {
      calls.push({ method: "groupParticipantsUpdate", jid, jids, action });
      return jids.map((j) => ({ jid: j, status: "200" }));
    },
    groupUpdateSubject: async (jid, name) => calls.push({ method: "groupUpdateSubject", jid, name }),
    groupUpdateDescription: async (jid, desc) => calls.push({ method: "groupUpdateDescription", jid, desc }),
    groupInviteCode: async () => "TESTCODE123",
    groupRevokeInvite: async () => "REVOKED456",
    groupSettingUpdate: async (jid, setting) => calls.push({ method: "groupSettingUpdate", jid, setting }),
    groupJoinApprovalMode: async (jid, mode) => calls.push({ method: "groupJoinApprovalMode", jid, mode }),
    groupMemberAddMode: async (jid, mode) => calls.push({ method: "groupMemberAddMode", jid, mode }),
    groupRequestParticipantsList: async () => [{ jid: "628123456789@s.whatsapp.net", phone_number: "628123456789@s.whatsapp.net" }],
    groupRequestParticipantsUpdate: async (jid, jids, action) => calls.push({ method: "groupRequestParticipantsUpdate", jid, jids, action }),
    groupToggleEphemeral: async (jid, seconds) => calls.push({ method: "groupToggleEphemeral", jid, seconds }),
    groupLeave: async (jid) => calls.push({ method: "groupLeave", jid }),
    sendPresenceUpdate: async () => {},
    profilePictureUrl: async () => null,
    prepareMedia: async () => ({ imageMessage: { url: "https://example.com/x.jpg" } }),
    waUploadToServer: {},
    store: { contacts: {} },
    updateMediaMessage: async () => {},
  };
  extendSocket(sock);
  return { sock, sent, calls };
}

function rawMsg(body, { group = "1000@g.us", sender = USER, quoted = null, mentions = [] } = {}) {
  const message = quoted
    ? {
        extendedTextMessage: {
          text: body,
          contextInfo: {
            quotedMessage: { conversation: quoted },
            participant: ADMIN,
            stanzaId: "QUOTED1",
            mentionedJid: mentions,
          },
        },
      }
    : mentions.length
      ? { extendedTextMessage: { text: body, contextInfo: { mentionedJid: mentions } } }
      : { conversation: body };
  return {
    key: {
      remoteJid: group === null ? sender : group,
      fromMe: false,
      id: `MSG${Math.random().toString(36).slice(2)}`,
      participant: group ? sender : undefined,
    },
    message,
    messageTimestamp: Math.floor(Date.now() / 1000),
    pushName: "Tester",
  };
}

const results = [];
async function test(name, fn) {
  try {
    // Clear per-user cooldowns so cross-test reuse of a sender never trips the
    // global per-command cooldown (which is keyed by user+command, not chat).
    if (db.db?.data?.users) {
      for (const u of Object.values(db.db.data.users)) if (u) u.cooldowns = {};
    }
    await fn();
    results.push({ name, ok: true });
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
  }
}

function textOf(sent) {
  return sent.map((s) => s.content?.text || s.content?.caption || "").join("\n");
}

/* ─────────────────── 1. registration & no duplicates ─────────────────── */

await test("all new commands registered", async () => {
  const expected = [
    "registergroup", "unregistergroup", "regcontrol", "link", "unlink", "links", "listreg",
    "setgroupalias", "log", "logs", "del",
    "kickall", "fban", "pending", "approve", "reject", "admin", "unadmin",
    "sendmessage", "editsettings", "joinapproval", "memberaddmode", "disappear",
    "addnote", "getnote", "notes", "delnote", "allowsavenote",
    "whitelist", "enablecmd", "disablecmd", "cmdaccess", "allowadmin",
    "fedcreate", "fedjoin", "fedleave", "fed",
    "antilink", "antivirtex", "antinsfw", "antivirtexdm", "blacklist", "unblacklist", "blacklists",
    "addfilter", "delfilter", "filters", "filtercd",
    "schedule", "schedules", "unschedule", "settimezone",
    "commandcd", "bulkdelay", "bulkdelaystatus", "presencesim", "presencedelay", "presencestatus",
    "quotelimit", "revokelimit", "revokelimitstatus", "vpsinfo", "copy",
    "logscope", "rvoscope",
    "setuplevel", "levelstatus", "top", "resetlevel",
    "report", "purge", "help", "leave", "daftar", "profile",
    "animsticker", "animstickeroptions", "getvo", "tovideo",
    "update", "checkupdate",
  ];
  const missing = expected.filter((c) => !getPlugin(c));
  assert.equal(missing.length, 0, `missing: ${missing.join(", ")}`);
});

await test("help resolves for every command", async () => {
  const { buildCommandHelp } = await import("../lib/help.js");
  for (const name of ["kickall", "antilink", "schedule", "vpsinfo", "help"]) {
    const detail = buildCommandHelp(name, ".");
    assert.ok(detail && detail.includes(name), `help missing for ${name}`);
  }
});

/* ─────────────────── 2. permission tiers ─────────────────── */

await test("owner command blocked for plain user", async () => {
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".whitelist list", { sender: USER }), sock);
  assert.ok(textOf(sent).toLowerCase().includes("owner"), `got: ${textOf(sent)}`);
});

await test("owner command allowed for owner", async () => {
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".whitelist add 628111222333", { sender: OWNER }), sock);
  assert.ok(textOf(sent).includes("ditambahkan"), `got: ${textOf(sent)}`);
});

await test("owner command allowed for whitelisted (private chat)", async () => {
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".whitelist list", { sender: WHITELIST, group: null }), sock);
  assert.ok(textOf(sent).includes("Whitelist"), `got: ${textOf(sent)}`);
});

await test("whitelist grants no privilege inside a group", async () => {
  // A whitelisted number is an ordinary member in a group: an owner-tier
  // command must be refused, and an admin-tier command must not be auto-granted.
  let { sock, sent } = makeSock();
  await messageHandler(rawMsg(".whitelist list", { sender: WHITELIST, group: "2001@g.us" }), sock);
  assert.ok(textOf(sent).toLowerCase().includes("owner"), `owner-tier leak: ${textOf(sent)}`);

  ({ sock, sent } = makeSock());
  await messageHandler(rawMsg(".antilink on", { sender: WHITELIST, group: "2002@g.us" }), sock);
  assert.ok(textOf(sent).toLowerCase().includes("admin"), `admin-tier leak: ${textOf(sent)}`);
});

await test("whitelist on/off toggles the feature", async () => {
  const { isWhitelistEnabled } = await import("../lib/access.js");
  const { isWhitelisted } = await import("../lib/access.js");

  let { sock, sent } = makeSock();
  await messageHandler(rawMsg(".whitelist off", { sender: OWNER, group: null }), sock);
  assert.ok(textOf(sent).includes("dimatikan"), `got: ${textOf(sent)}`);
  assert.equal(isWhitelistEnabled(), false, "feature should be off");
  assert.equal(isWhitelisted(WHITELIST), false, "whitelist must not apply while off");

  ({ sock, sent } = makeSock());
  await messageHandler(rawMsg(".whitelist on", { sender: OWNER, group: null }), sock);
  assert.ok(textOf(sent).includes("diaktifkan"), `got: ${textOf(sent)}`);
  assert.equal(isWhitelistEnabled(), true, "feature should be back on");
  assert.equal(isWhitelisted(WHITELIST), true, "whitelist applies again once on");
});

await test("admin command blocked for plain user", async () => {
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".antilink on", { sender: USER }), sock);
  assert.ok(textOf(sent).toLowerCase().includes("admin"), `got: ${textOf(sent)}`);
});

await test("admin command allowed for group admin", async () => {
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".antilink on", { sender: ADMIN, group: "2000@g.us" }), sock);
  assert.ok(textOf(sent).includes("diaktifkan"), `got: ${textOf(sent)}`);
});

await test("group-only command blocked in private", async () => {
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".antilink on", { group: null, sender: ADMIN }), sock);
  const text = textOf(sent).toLowerCase();
  assert.ok(text.includes("grup") || text.includes("group"), `got: ${textOf(sent)}`);
});

await test("admin commands disabled by allowadmin off", async () => {
  const chat = "3000@g.us";
  db.setGroup(chat, { allowAdminCommands: false });
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".antilink on", { sender: ADMIN, group: chat }), sock);
  assert.ok(textOf(sent).toLowerCase().includes("admin"), `got: ${textOf(sent)}`);
  db.setGroup(chat, { allowAdminCommands: true });
});

/* ─────────────────── 3. kickall two-stage confirmation ─────────────────── */

await test("kickall requires confirmation (stage 1)", async () => {
  const chat = "4000@g.us";
  const { sock, sent, calls } = makeSock();
  await messageHandler(rawMsg(".kickall", { sender: ADMIN, group: chat }), sock);
  const text = textOf(sent);
  assert.ok(text.includes("KONFIRMASI") || text.includes("confirm"), `got: ${text}`);
  assert.equal(calls.filter((c) => c.method === "groupParticipantsUpdate").length, 0, "must not remove anyone in stage 1");
});

await test("kickall confirm removes non-admins", async () => {
  const chat = "4001@g.us";
  const { sock, sent, calls } = makeSock();
  await messageHandler(rawMsg(".kickall", { sender: ADMIN, group: chat }), sock);
  const token = (textOf(sent).match(/kickall confirm ([a-f0-9-]{36})/i) || [])[1];
  assert.ok(token, `no token in: ${textOf(sent)}`);

  const { sock: sock2, sent: sent2, calls: calls2 } = makeSock();
  await messageHandler(rawMsg(`.kickall confirm ${token}`, { sender: ADMIN, group: chat }), sock2);
  const updates = calls2.filter((c) => c.method === "groupParticipantsUpdate");
  assert.ok(updates.length >= 1, "expected a removal call");
  assert.equal(updates[0].action, "remove");
  assert.ok(textOf(sent2).includes("Selesai"), `got: ${textOf(sent2)}`);
});

await test("kickall token cannot be used by another user", async () => {
  const chat = "4002@g.us";
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".kickall", { sender: ADMIN, group: chat }), sock);
  const token = (textOf(sent).match(/kickall confirm ([a-f0-9-]{36})/i) || [])[1];
  assert.ok(token, "no token");

  // A different (still-admin) user must not be able to consume the token.
  const { sock: sock2, sent: sent2 } = makeSock();
  await messageHandler(rawMsg(`.kickall confirm ${token}`, { sender: ADMIN2, group: chat }), sock2);
  assert.ok(textOf(sent2).toLowerCase().includes("tidak valid"), `got: ${textOf(sent2)}`);
});

await test("kickall cancel works", async () => {
  const chat = "4003@g.us";
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".kickall", { sender: ADMIN, group: chat }), sock);
  const { sock: sock2, sent: sent2 } = makeSock();
  await messageHandler(rawMsg(".kickall cancel", { sender: ADMIN, group: chat }), sock2);
  assert.ok(textOf(sent2).toLowerCase().includes("dibatalkan"), `got: ${textOf(sent2)}`);
});

/* ─────────────────── 4. moderation ─────────────────── */

await test("antilink deletes link from plain member", async () => {
  const chat = "5000@g.us";
  db.setGroup(chat, { antilink: true });
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg("check this https://spam.example.com", { sender: USER, group: chat }), sock);
  const deleted = sent.find((s) => s.content?.delete);
  assert.ok(deleted, `expected a delete; got: ${JSON.stringify(sent.map((s) => s.content))}`);
});

await test("antilink spares group admin", async () => {
  const chat = "5001@g.us";
  db.setGroup(chat, { antilink: true });
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg("https://ok.example.com", { sender: ADMIN, group: chat }), sock);
  const deleted = sent.find((s) => s.content?.delete);
  assert.ok(!deleted, "admin link must not be deleted");
});

await test("blacklist deletes banned word", async () => {
  const chat = "5002@g.us";
  db.addBlacklist(chat, "judi", OWNER);
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg("ayo main judi yuk", { sender: USER, group: chat }), sock);
  const deleted = sent.find((s) => s.content?.delete);
  assert.ok(deleted, "expected blacklist deletion");
});

await test("antivirtex deletes virtex-like spam", async () => {
  const chat = "5003@g.us";
  db.setGroup(chat, { antivirtex: true });
  const { sock, sent } = makeSock();
  const virtex = "\u0301".repeat(60) + "a".repeat(200);
  await messageHandler(rawMsg(virtex, { sender: USER, group: chat }), sock);
  const deleted = sent.find((s) => s.content?.delete);
  assert.ok(deleted, "expected antivirtex deletion");
});

/* ─────────────────── 5. filters ─────────────────── */

await test("addfilter + trigger auto-reply", async () => {
  const chat = "6000@g.us";
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".addfilter halo Halo juga!", { sender: ADMIN, group: chat }), sock);
  assert.ok(textOf(sent).includes("disimpan"), `addfilter: ${textOf(sent)}`);

  const { sock: sock2, sent: sent2 } = makeSock();
  await messageHandler(rawMsg("halo", { sender: USER, group: chat }), sock2);
  const replied = sent2.some((s) => (s.content?.text || "").includes("Halo juga!"));
  assert.ok(replied, `expected filter reply; got: ${textOf(sent2)}`);
});

await test("filter list renders as plain text", async () => {
  const chat = "6001@g.us";
  db.setFilter(chat, "ping", { content: "pong", createdBy: ADMIN });
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".filters", { sender: ADMIN, group: chat }), sock);
  assert.ok(!sent.find((s) => s.relayed), "filters must not send an interactive flow");
  const text = textOf(sent);
  assert.ok(text.includes("Filter") && text.includes("ping"), `got: ${text}`);
});

await test("addfilter regex with spaces (quoted) fires", async () => {
  const chat = "6010@g.us";
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg('.addfilter "re:^halo dunia$" Hai juga!', { sender: ADMIN, group: chat }), sock);
  assert.ok(textOf(sent).includes("re:^halo dunia$"), `trigger truncated: ${textOf(sent)}`);

  const { sock: sock2, sent: sent2 } = makeSock();
  await messageHandler(rawMsg("halo dunia", { sender: USER, group: chat }), sock2);
  assert.ok(sent2.some((s) => (s.content?.text || "").includes("Hai juga!")), `expected reply; got: ${textOf(sent2)}`);

  const { sock: sock3, sent: sent3 } = makeSock();
  await messageHandler(rawMsg("halo dunia semuanya", { sender: USER, group: chat }), sock3);
  assert.ok(!sent3.some((s) => (s.content?.text || "").includes("Hai juga!")), `must not reply: ${textOf(sent3)}`);

  // Deleting a spaced regex trigger must target the whole pattern, not a token.
  const { sock: sock4, sent: sent4 } = makeSock();
  await messageHandler(rawMsg('.delfilter "re:^halo dunia$"', { sender: ADMIN, group: chat }), sock4);
  assert.ok(textOf(sent4).includes("dihapus"), `expected delete; got: ${textOf(sent4)}`);
  assert.equal(db.listFilters(chat).length, 0, "spaced regex trigger must be fully removed");
});

await test("addfilter regex via reply keeps whole pattern", async () => {
  const chat = "6011@g.us";
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".addfilter re:^apa kabar$", { sender: ADMIN, group: chat, quoted: "Pesan apapun" }), sock);
  assert.ok(textOf(sent).includes("re:^apa kabar$"), `got: ${textOf(sent)}`);

  const { sock: sock2, sent: sent2 } = makeSock();
  await messageHandler(rawMsg("apa kabar", { sender: USER, group: chat }), sock2);
  assert.ok(sent2.some((s) => (s.content?.text || "").includes("Pesan apapun")), `expected reply; got: ${textOf(sent2)}`);
});

await test("regex source case is preserved (\\D stays \\D)", async () => {
  const chat = "6012@g.us";
  db.setFilter(chat, "re:^\\D+$", { content: "NonDigit!", createdBy: ADMIN });
  assert.ok(db.listFilters(chat).some((f) => f.trigger === "re:^\\D+$"), "regex trigger lowercased/corrupted");

  const { sock, sent } = makeSock();
  await messageHandler(rawMsg("abc", { sender: USER, group: chat }), sock);
  assert.ok(sent.some((s) => (s.content?.text || "").includes("NonDigit!")), `\\D should match abc: ${textOf(sent)}`);

  const { sock: sock2, sent: sent2 } = makeSock();
  await messageHandler(rawMsg("123", { sender: USER, group: chat }), sock2);
  assert.ok(!sent2.some((s) => (s.content?.text || "").includes("NonDigit!")), `\\D must not match 123: ${textOf(sent2)}`);
});

await test("invalid regex filter is rejected", async () => {
  const chat = "6013@g.us";
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg('.addfilter "re:[" Oops!', { sender: ADMIN, group: chat }), sock);
  assert.ok(textOf(sent).includes("tidak valid"), `got: ${textOf(sent)}`);
  assert.equal(db.listFilters(chat).length, 0, "invalid filter must not be stored");
});

await test("blacklist regex matches and deletes", async () => {
  const chat = "6014@g.us";
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".blacklist re:\\d{4,}", { sender: ADMIN, group: chat }), sock);
  assert.ok(textOf(sent).includes("ditambahkan"), `got: ${textOf(sent)}`);

  const { sock: sock2, sent: sent2 } = makeSock();
  await messageHandler(rawMsg("nomor saya 12345", { sender: USER, group: chat }), sock2);
  assert.ok(sent2.some((s) => s.content?.delete), `expected deletion: ${textOf(sent2)}`);

  const { sock: sock3, sent: sent3 } = makeSock();
  await messageHandler(rawMsg("nomor saya 12", { sender: USER, group: chat }), sock3);
  assert.ok(!sent3.some((s) => s.content?.delete), `must not delete: ${textOf(sent3)}`);
});

await test("filter list renders plain text (regex trigger shown, no flow)", async () => {
  const chat = "6015@g.us";
  db.setFilter(chat, "re:^halo dunia$", { content: "Hai juga!", createdBy: ADMIN });
  db.setFilter(chat, "plain", { content: "Plain reply", createdBy: ADMIN });

  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".filters", { sender: ADMIN, group: chat }), sock);
  assert.ok(!sent.find((s) => s.relayed), "filters must not send an interactive flow");
  const text = textOf(sent);
  assert.ok(text.includes("re:^halo dunia$"), `regex trigger missing: ${text}`);
  assert.ok(text.includes("plain"), `plain trigger missing: ${text}`);
  assert.ok(text.includes("delfilter"), `expected delete hint: ${text}`);
});

/* ─────────────────── 6. notes gate ─────────────────── */

await test("allowsavenote admin blocks plain user", async () => {
  const chat = "7000@g.us";
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".allowsavenote admin", { sender: ADMIN, group: chat }), sock);
  assert.ok(textOf(sent).includes("admin"), `got: ${textOf(sent)}`);

  const { sock: sock2, sent: sent2 } = makeSock();
  await messageHandler(rawMsg(".addnote secret hello", { sender: USER, group: chat }), sock2);
  assert.ok(textOf(sent2).toLowerCase().includes("admin"), `got: ${textOf(sent2)}`);
});

/* ─────────────────── 7. schedule persistence ─────────────────── */

await test("schedule persists and is listed", async () => {
  const chat = "8000@g.us";
  db.registerGroup(chat, { name: "Sched", status: "active", activated: true });
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(`.schedule 8000 08:00 daily`, { sender: ADMIN, group: chat, quoted: "Pesan harian" }), sock);
  assert.ok(textOf(sent).includes("Jadwal dibuat"), `got: ${textOf(sent)}`);
  const schedules = db.listSchedules().filter((s) => s.jid === chat);
  assert.equal(schedules.length, 1, "schedule not persisted");
  assert.equal(schedules[0].sendTime, "08:00");
  assert.equal(schedules[0].recurrence, "daily");
});

await test("settimezone validates IANA", async () => {
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".settimezone Not/AZone", { sender: OWNER }), sock);
  assert.ok(textOf(sent).toLowerCase().includes("tidak valid"), `got: ${textOf(sent)}`);

  const { sock: sock2, sent: sent2 } = makeSock();
  await messageHandler(rawMsg(".settimezone Asia/Makassar", { sender: OWNER }), sock2);
  assert.ok(textOf(sent2).includes("Asia/Makassar"), `got: ${textOf(sent2)}`);
  const { getConfiguredTimezone } = await import("../lib/settings.js");
  assert.equal(getConfiguredTimezone(), "Asia/Makassar");
});

/* ─────────────────── 8. bot config ─────────────────── */

await test("commandcd sets group cooldown", async () => {
  const chat = "9000@g.us";
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".commandcd 5s", { sender: ADMIN, group: chat }), sock);
  assert.ok(textOf(sent).includes("5s"), `got: ${textOf(sent)}`);
  const { getGroupCooldown } = await import("../lib/cooldown.js");
  assert.equal(getGroupCooldown(chat), 5);
});

await test("disablecmd + enablecmd", async () => {
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".disablecmd qr", { sender: OWNER }), sock);
  assert.ok(textOf(sent).includes("global"), `got: ${textOf(sent)}`);
  assert.ok((db.setting("disabledCommands") || []).includes("qr"));

  const { sock: sock2, sent: sent2 } = makeSock();
  await messageHandler(rawMsg(".enablecmd qr", { sender: OWNER }), sock2);
  assert.ok(!(db.setting("disabledCommands") || []).includes("qr"));
});

await test("cmdaccess overrides tier", async () => {
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".cmdaccess sticker owner", { sender: OWNER }), sock);
  assert.ok(textOf(sent).includes("owner"), `got: ${textOf(sent)}`);
  assert.equal((db.setting("commandAccess") || {}).sticker, "owner");

  // now sticker is owner-only: plain user blocked
  const { sock: sock2, sent: sent2 } = makeSock();
  await messageHandler(rawMsg(".sticker", { sender: USER }), sock2);
  assert.ok(textOf(sent2).toLowerCase().includes("owner"), `got: ${textOf(sent2)}`);
  await messageHandler(rawMsg(".cmdaccess sticker reset", { sender: OWNER }), makeSock().sock);
});

/* ─────────────────── 9. levels ─────────────────── */

await test("level XP only accrues when enabled", async () => {
  const chat = "9100@g.us";
  const { sock } = makeSock();
  await messageHandler(rawMsg("hi", { sender: USER, group: chat }), sock);
  assert.equal(db.getLevel(USER, chat), null, "XP accrued while disabled");

  db.setGroup(chat, { levelEnabled: true });
  const { sock: sock2 } = makeSock();
  await messageHandler(rawMsg("hi again", { sender: USER, group: chat }), sock2);
  const rec = db.getLevel(USER, chat);
  assert.ok(rec && rec.xp > 0, "XP did not accrue when enabled");
});

/* ─────────────────── 10. no-secret guarantees ─────────────────── */

await test("sysinfo (alias of botinfo) exposes no secrets", async () => {
  process.env.NSFW_API_KEY = "SUPERSECRET_ABC123";
  process.env.BOT_NUMBER = "628123456789";
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".sysinfo", { sender: OWNER }), sock);
  const text = textOf(sent);
  assert.ok(text.includes("info") && text.includes("runtime"), `got: ${text}`);
  const forbidden = ["SUPERSECRET_ABC123", "process.env", ".env", "password", "apiKey", "creds.json", dbPath];
  for (const needle of forbidden) {
    assert.ok(!text.includes(needle), `sysinfo leaked "${needle}"`);
  }
});

await test(".vpsinfo shows host metrics without secrets", async () => {
  process.env.SUPER_TOKEN = "LEAK_ME_XYZ";
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".vpsinfo", { sender: OWNER }), sock);
  const text = textOf(sent);
  assert.ok(text.includes("VPS / SERVER INFO"), `got: ${text}`);
  assert.ok(text.includes("CPU") && text.includes("MEMORY"), `missing sections: ${text}`);
  const forbidden = ["LEAK_ME_XYZ", "process.env", ".env", "password", "apiKey", "creds.json", dbPath];
  for (const needle of forbidden) {
    assert.ok(!text.includes(needle), `vpsinfo leaked "${needle}"`);
  }
});

await test("copy rejects a path argument (no arbitrary read)", async () => {
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".copy /etc/passwd", { sender: OWNER }), sock);
  // `.copy` ignores arguments entirely — it never reads the given path; the only
  // files it ever archives are those inside the project directory (process.cwd()).
  const doc = sent.find((s) => s.content?.document);
  assert.ok(doc, `expected a zip document; got: ${JSON.stringify(sent.map((s) => Object.keys(s.content || {})))}`);
  assert.ok(!String(doc.content.fileName || "").includes("passwd"), "filename must not echo the path");
  assert.ok(!String(doc.content.caption || "").includes("passwd"), "caption must not echo the path");
});

/* ─────────────────── 11. leave is owner-only ─────────────────── */

await test("leave blocked for plain user", async () => {
  const { sock, sent, calls } = makeSock();
  await messageHandler(rawMsg(".leave", { sender: USER, group: "9999@g.us" }), sock);
  assert.ok(textOf(sent).toLowerCase().includes("owner"), `got: ${textOf(sent)}`);
  assert.equal(calls.filter((c) => c.method === "groupLeave").length, 0, "must not leave");
});

/* ─────────────────── 12. group-setup registry ─────────────────── */

await test("registergroup + listreg + registration gate", async () => {
  const chat = "12000@g.us";
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".registergroup Tim Uji", { sender: OWNER, group: chat }), sock);
  assert.ok(textOf(sent).includes("didaftarkan"), `got: ${textOf(sent)}`);
  assert.ok(db.getRegistration(chat), "registration not stored");
  assert.equal(db.getRegistration(chat).name, "Tim Uji");

  // now flip the gate to "registered" and confirm an unregistered group is blocked
  const { sock: s2, sent: sent2 } = makeSock();
  await messageHandler(rawMsg(".regcontrol registered", { sender: OWNER }), s2);
  const { sock: s3, sent: sent3 } = makeSock();
  await messageHandler(rawMsg(".ping", { sender: USER, group: "12001@g.us" }), s3);
  assert.ok(textOf(sent3).includes("belum terdaftar") || textOf(sent3).includes("terdaftar"), `gate: ${textOf(sent3)}`);

  // the registered group still works
  const { sock: s4, sent: sent4 } = makeSock();
  await messageHandler(rawMsg(".ping", { sender: USER, group: chat }), s4);
  assert.ok(!textOf(sent4).includes("belum terdaftar"), `registered blocked: ${textOf(sent4)}`);

  // reset the gate so later tests are unaffected
  await messageHandler(rawMsg(".regcontrol open", { sender: OWNER }), makeSock().sock);
  assert.equal(db.setting("regMode"), "open");
});

await test("unregistergroup removes the registration", async () => {
  const chat = "12002@g.us";
  db.registerGroup(chat, { name: "Temp", status: "active", activated: true });
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".unregistergroup", { sender: OWNER, group: chat }), sock);
  assert.ok(db.getRegistration(chat) === null, "registration not removed");
});

await test("link + links + unlink (management→target)", async () => {
  const mgmt = "12100@g.us";
  const target = "12101@g.us";
  db.registerGroup(mgmt, { name: "Mgmt", status: "active", activated: true });
  db.registerGroup(target, { name: "Target", status: "active", activated: true });

  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".link 12101", { sender: OWNER, group: mgmt }), sock);
  assert.ok(db.isLinked(mgmt, target), `link failed: ${textOf(sent)}`);

  const { sock: s2, sent: sent2 } = makeSock();
  await messageHandler(rawMsg(".links", { sender: OWNER, group: mgmt }), s2);
  const linksRelayed = sent2.find((s) => s.relayed);
  assert.ok(linksRelayed || textOf(sent2).includes("Target") || textOf(sent2).includes("12101"), `links: ${textOf(sent2)}`);

  const { sock: s3 } = makeSock();
  await messageHandler(rawMsg(".unlink 12101", { sender: OWNER, group: mgmt }), s3);
  assert.ok(!db.isLinked(mgmt, target), "unlink failed");
});

/* ─────────────────── 13. group management ─────────────────── */

await test("admin/unadmin promote & demote", async () => {
  const chat = "13000@g.us";
  const target = "628000000050@s.whatsapp.net";
  const { sock, calls } = makeSock();
  await messageHandler(rawMsg(".admin", { sender: ADMIN, group: chat, mentions: [target] }), sock);
  const promote = calls.find((c) => c.method === "groupParticipantsUpdate" && c.action === "promote");
  assert.ok(promote, "no promote call");
  assert.ok(promote.jids.includes(target));

  const { sock: s2, calls: calls2 } = makeSock();
  await messageHandler(rawMsg(".unadmin", { sender: ADMIN, group: chat, mentions: [target] }), s2);
  const demote = calls2.find((c) => c.method === "groupParticipantsUpdate" && c.action === "demote");
  assert.ok(demote, "no demote call");
});

await test("disappear sets ephemeral timer", async () => {
  const chat = "13001@g.us";
  const { sock, calls } = makeSock();
  await messageHandler(rawMsg(".disappear 24h", { sender: ADMIN, group: chat }), sock);
  const call = calls.find((c) => c.method === "groupToggleEphemeral");
  assert.ok(call, "no ephemeral call");
  assert.equal(call.seconds, 86400);
});

await test("joinapproval toggles approval mode", async () => {
  const chat = "13002@g.us";
  const { sock, calls } = makeSock();
  await messageHandler(rawMsg(".joinapproval on", { sender: ADMIN, group: chat }), sock);
  const call = calls.find((c) => c.method === "groupJoinApprovalMode");
  assert.ok(call, "no joinapproval call");
});

await test("pending lists join requests", async () => {
  const chat = "13003@g.us";
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".pending", { sender: ADMIN, group: chat }), sock);
  assert.ok(textOf(sent).includes("628123456789") || textOf(sent).toLowerCase().includes("pending") || textOf(sent).toLowerCase().includes("permintaan"), `got: ${textOf(sent)}`);
});

await test("sendmessage toggles announcement mode", async () => {
  const chat = "13004@g.us";
  const { sock, calls } = makeSock();
  await messageHandler(rawMsg(".sendmessage off", { sender: ADMIN, group: chat }), sock);
  const call = calls.find((c) => c.method === "groupSettingUpdate");
  assert.ok(call, "no setting call");
  assert.equal(call.setting, "announcement");
});

/* ─────────────────── 14. federation ─────────────────── */

await test("fedcreate + fedjoin + fedleave", async () => {
  const g1 = "14000@g.us";
  const g2 = "14001@g.us";
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".fedcreate Nusantara", { sender: OWNER, group: g1 }), sock);
  const fedId = (textOf(sent).match(/ID: `([^`]+)`/) || [])[1];
  assert.ok(fedId, `no federation id: ${textOf(sent)}`);
  assert.ok(db.getFederation(fedId), "federation not created");

  const { sock: s2 } = makeSock();
  await messageHandler(rawMsg(`.fedjoin ${fedId}`, { sender: OWNER, group: g2 }), s2);
  assert.ok(db.getFederation(fedId).groups.includes(g2), "g2 not joined");

  const { sock: s3 } = makeSock();
  await messageHandler(rawMsg(".fedleave", { sender: OWNER, group: g2 }), s3);
  assert.ok(!db.getFederation(fedId).groups.includes(g2), "g2 did not leave");
});

await test("fban bans across the linked federation and lists / unbans", async () => {
  const g1 = "14100@g.us";
  const g2 = "14101@g.us";
  const banned = "628111222333"; // not an owner

  /* create a fed in g1 and join g2 */
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".fedcreate Federasi Test", { sender: OWNER, group: g1 }), sock);
  const fedId = (textOf(sent).match(/ID: `([^`]+)`/) || [])[1];
  assert.ok(fedId, `no federation id: ${textOf(sent)}`);
  await messageHandler(rawMsg(`.fedjoin ${fedId}`, { sender: OWNER, group: g2 }), makeSock().sock);
  assert.ok(db.getFederation(fedId).groups.includes(g2), "g2 not joined");

  /* `.fban <number>` with no fed → uses the linked federation (g1) */
  const { sock: s1, calls: c1 } = makeSock();
  await messageHandler(rawMsg(`.fban ${banned}`, { sender: ADMIN, group: g1 }), s1);
  const removed = c1.filter((c) => c.method === "groupParticipantsUpdate" && c.action === "remove");
  assert.ok(removed.some((c) => c.jid === g1), "target not removed from g1");
  assert.ok(removed.some((c) => c.jid === g2), "target not removed from sibling g2");
  assert.ok(db.listFederationBans(fedId).includes(banned), "ban not recorded");

  /* `.fban list <name>` shows the banned number */
  const { sock: s2, sent: sent2 } = makeSock();
  await messageHandler(rawMsg(".fban list Federasi Test", { sender: ADMIN2, group: g1 }), s2);
  assert.ok(textOf(sent2).includes(`@${banned}`), `list missing ban: ${textOf(sent2)}`);

  /* `.fban unban <fed> <number>` lifts it */
  const { sock: s3, sent: sent3 } = makeSock();
  await messageHandler(rawMsg(`.fban unban ${fedId} ${banned}`, { sender: OWNER, group: g1 }), s3);
  assert.ok(!db.listFederationBans(fedId).includes(banned), `unban failed: ${textOf(sent3)}`);
});

await test("fban with an explicit fed targets that federation", async () => {
  const gA = "14110@g.us";
  const gB = "14111@g.us";
  const banned = "628444555666";

  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".fedcreate Fed A", { sender: OWNER, group: gA }), sock);
  const fedA = (textOf(sent).match(/ID: `([^`]+)`/) || [])[1];
  await messageHandler(rawMsg(".fedcreate Fed B", { sender: OWNER, group: gB }), makeSock().sock);
  const fedB = db.findFederation("Fed B").id;
  assert.ok(fedA && fedB && fedA !== fedB, "feds not distinct");

  /* run in gA but ban into Fed B explicitly → gB affected, gA not */
  const { sock: s1, calls: c1 } = makeSock();
  await messageHandler(rawMsg(`.fban ${fedB} ${banned}`, { sender: ADMIN, group: gA }), s1);
  const removed = c1.filter((c) => c.method === "groupParticipantsUpdate" && c.action === "remove");
  assert.ok(removed.some((c) => c.jid === gB), "explicit fed not targeted");
  assert.ok(!removed.some((c) => c.jid === gA), "must not ban in the linked fed");
  assert.ok(db.listFederationBans(fedB).includes(banned), "ban not recorded on explicit fed");
  assert.ok(!db.listFederationBans(fedA).includes(banned), "ban leaked to linked fed");
});

await test(".fed list / .fedinfo show federations and their stats", async () => {
  const g = "14120@g.us";
  const banned = "628777888999";

  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".fedcreate Nusantara Raya", { sender: OWNER, group: g }), sock);
  const fed = db.findFederation("Nusantara Raya");
  assert.ok(fed && fed.alias, `fed/alias not set: ${textOf(sent)}`);

  db.addFederationBan(fed.id, banned);

  /* `.fed list` lists it (by name + alias) */
  const { sock: s1, sent: sent1 } = makeSock();
  await messageHandler(rawMsg(".fed list", { sender: OWNER, group: null }), s1);
  assert.ok(textOf(sent1).includes("DAFTAR FEDERASI"), `list header missing: ${textOf(sent1)}`);
  assert.ok(textOf(sent1).includes(fed.alias), `alias missing from list: ${textOf(sent1)}`);

  /* `.fedinfo <alias>` shows stats incl. the ban count */
  const { sock: s2, sent: sent2 } = makeSock();
  await messageHandler(rawMsg(`.fedinfo ${fed.alias}`, { sender: OWNER, group: null }), s2);
  assert.ok(textOf(sent2).includes("Info Federasi"), `info header missing: ${textOf(sent2)}`);
  assert.ok(textOf(sent2).includes(`@${banned}`), `info missing ban: ${textOf(sent2)}`);

  /* `.fed info` with no arg falls back to the linked federation */
  const { sock: s3, sent: sent3 } = makeSock();
  await messageHandler(rawMsg(".fed info", { sender: OWNER, group: g }), s3);
  assert.ok(textOf(sent3).includes("Info Federasi"), `linked info missing: ${textOf(sent3)}`);
});

await test(".fedjoin accepts an alias and can target another group", async () => {
  const g1 = "14130@g.us";
  const g2 = "14131@g.us";
  const { setGroupAlias } = await import("../lib/group-registry.js");

  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".fedcreate Alpha Fed", { sender: OWNER, group: g1 }), sock);
  const fed = db.findFederation("Alpha Fed");
  assert.ok(fed?.alias, `no alias: ${textOf(sent)}`);

  /* register g2 and give it an alias so `.fedjoin <fed> <grup>` can target it */
  db.registerGroup(g2, { name: "Fed Join Target", status: "active", activated: true });
  setGroupAlias(g2, "fed-target");

  const { sock: s1 } = makeSock();
  await messageHandler(rawMsg(`.fedjoin ${fed.alias} fed-target`, { sender: OWNER, group: g1 }), s1);
  assert.ok(db.getFederation(fed.id).groups.includes(g2), "g2 not joined via alias");
  assert.equal(db.getGroup(g2).federationId, fed.id, "g2 federationId not set");
});

await test(".fedjoin with no group joins the current group", async () => {
  const g = "14140@g.us";
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".fedcreate Beta Fed", { sender: OWNER, group: g }), sock);
  const fed = db.findFederation("Beta Fed");

  const other = "14141@g.us";
  const { sock: s1 } = makeSock();
  await messageHandler(rawMsg(`.fedjoin ${fed.alias}`, { sender: OWNER, group: other }), s1);
  assert.ok(db.getFederation(fed.id).groups.includes(other), "current group not joined");
  assert.equal(db.getGroup(other).federationId, fed.id, "current group federationId not set");
});

/* ─────────────────── 15. security toggles persist ─────────────────── */

await test("security toggles persist to the group record", async () => {
  const chat = "15000@g.us";
  const { sock } = makeSock();
  await messageHandler(rawMsg(".antilink on", { sender: ADMIN, group: chat }), sock);
  await messageHandler(rawMsg(".antivirtex on", { sender: ADMIN, group: chat }), sock);
  await messageHandler(rawMsg(".antinsfw on", { sender: ADMIN, group: chat }), sock);
  const group = db.getGroup(chat);
  assert.equal(group.antilink, true);
  assert.equal(group.antivirtex, true);
  assert.equal(group.antinsfw, true);
});

await test("blacklist add/list/remove", async () => {
  const chat = "15001@g.us";
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".blacklist judi", { sender: ADMIN, group: chat }), sock);
  assert.ok(db.listBlacklist(chat).some((e) => e.entry === "judi"), `add failed: ${textOf(sent)}`);

  const { sock: s2 } = makeSock();
  await messageHandler(rawMsg(".unblacklist judi", { sender: ADMIN, group: chat }), s2);
  assert.ok(!db.listBlacklist(chat).some((e) => e.entry === "judi"), "remove failed");
});

await test("antivirtexdm is owner-only", async () => {
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".antivirtexdm on", { sender: USER }), sock);
  assert.ok(textOf(sent).toLowerCase().includes("owner"), `got: ${textOf(sent)}`);
});

/* ─────────────────── 16. bot-config extras ─────────────────── */

await test("bulkdelay validates range", async () => {
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".bulkdelay 9000 100", { sender: OWNER }), sock);
  assert.ok(textOf(sent).toLowerCase().includes("usage"), `got: ${textOf(sent)}`);

  const { sock: s2, sent: sent2 } = makeSock();
  await messageHandler(rawMsg(".bulkdelay 400 900", { sender: OWNER }), s2);
  const { getBulkActionDelayRange } = await import("../lib/settings.js");
  assert.deepEqual(getBulkActionDelayRange(), [400, 900]);
});

await test("whitelist add/list/del", async () => {
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".whitelist add 628777666555", { sender: OWNER }), sock);
  assert.ok(db.isWhitelisted("628777666555"), `add failed: ${textOf(sent)}`);

  const { sock: s2, sent: sent2 } = makeSock();
  await messageHandler(rawMsg(".whitelist list", { sender: OWNER }), s2);
  assert.ok(textOf(sent2).includes("628777666555"), `list failed: ${textOf(sent2)}`);
  assert.ok(textOf(sent2).includes("Whitelist"), `list header missing: ${textOf(sent2)}`);

  const { sock: s3 } = makeSock();
  await messageHandler(rawMsg(".whitelist del 628777666555", { sender: OWNER }), s3);
  assert.ok(!db.isWhitelisted("628777666555"), "del failed");
});

/* ─────────────────── 17. levels (cont.) ─────────────────── */

await test("setuplevel + top + resetlevel", async () => {
  const chat = "17000@g.us";
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".setuplevel on", { sender: ADMIN, group: chat }), sock);
  assert.equal(db.getGroup(chat).levelEnabled, true, `setuplevel: ${textOf(sent)}`);

  db.addLevelXp(USER, chat, 500);
  db.addLevelXp(ADMIN, chat, 900);

  const { sock: s2, sent: sent2 } = makeSock();
  await messageHandler(rawMsg(".top", { sender: USER, group: chat }), s2);
  assert.ok(textOf(sent2).includes("Peringkat") || textOf(sent2).includes("Level"), `top: ${textOf(sent2)}`);

  const { sock: s3 } = makeSock();
  await messageHandler(rawMsg(".resetlevel", { sender: ADMIN, group: chat }), s3);
  assert.equal(db.getTopLevels(chat, 5).length, 0, "resetlevel failed");
});

await test("levelstatus shows sender progress", async () => {
  const chat = "17001@g.us";
  db.setGroup(chat, { levelEnabled: true });
  db.addLevelXp(USER, chat, 250);
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".levelstatus", { sender: USER, group: chat }), sock);
  assert.ok(textOf(sent).includes("Level") || textOf(sent).includes("XP"), `got: ${textOf(sent)}`);
});

/* ─────────────────── 18. utility extras ─────────────────── */

await test("daftar + profile", async () => {
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".daftar Budi", { sender: USER }), sock);
  assert.ok(textOf(sent).includes("Terdaftar"), `daftar: ${textOf(sent)}`);
  assert.ok(db.getUser(USER)?.isRegistered, "not registered");

  const { sock: s2, sent: sent2 } = makeSock();
  await messageHandler(rawMsg(".profile", { sender: USER }), s2);
  assert.ok(textOf(sent2).includes("PROFIL"), `profile: ${textOf(sent2)}`);
});

await test("report without management group is graceful", async () => {
  const chat = "18000@g.us";
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".report spam", { sender: USER, group: chat, quoted: "pesan buruk" }), sock);
  assert.ok(textOf(sent).toLowerCase().includes("manajemen") || textOf(sent).toLowerCase().includes("tidak"), `got: ${textOf(sent)}`);
});

await test("report delivers to linked management group", async () => {
  const mgmt = "18001@g.us";
  const target = "18002@g.us";
  db.registerGroup(mgmt, { name: "Mgmt2", status: "active", activated: true });
  db.registerGroup(target, { name: "Target2", status: "active", activated: true });
  db.linkGroup(mgmt, target);

  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".report spam", { sender: USER, group: target, quoted: "pesan buruk" }), sock);
  const toMgmt = sent.find((s) => s.jid === mgmt);
  assert.ok(toMgmt, `report not delivered: ${JSON.stringify(sent.map((s) => s.jid))}`);
});

await test("purge deletes tracked bot messages", async () => {
  const chat = "18003@g.us";
  const { sock, sent } = makeSock();
  // send two messages so they get tracked
  await sock.sendMessage(chat, { text: "one" });
  await sock.sendMessage(chat, { text: "two" });
  await messageHandler(rawMsg(".purge 2", { sender: ADMIN, group: chat }), sock);
  const deletes = sent.filter((s) => s.content?.delete);
  assert.ok(deletes.length >= 2, `expected >=2 deletes, got ${deletes.length}`);
});

/* ─────────────────── 19. help drill-down ─────────────────── */

await test("help flow: category list renders via relay", async () => {
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".help", { sender: USER }), sock);
  const relayed = sent.find((s) => s.relayed);
  const text = textOf(sent);
  assert.ok(relayed || text.includes("BANTUAN") || text.includes("kategori"), `got: ${text}`);
});

await test("help <command> shows detail card", async () => {
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".help kickall", { sender: USER }), sock);
  const text = textOf(sent);
  assert.ok(text.includes("kickall"), `got: ${text}`);
});

await test("scheduler fires a due schedule and marks it sent", async () => {
  const { runSchedulerTick } = await import("../lib/scheduler.js");
  const { getCurrentTimeParts, getConfiguredTimezone } = await import("../lib/settings.js");
  const chat = "19000@g.us";
  db.registerGroup(chat, { name: "Sched2", status: "active", activated: true });

  const now = getCurrentTimeParts(getConfiguredTimezone());
  const id = `sch_test_${Date.now().toString(36)}`;
  db.createSchedule(id, {
    jid: chat,
    content: "pesan terjadwal",
    sendTime: now.hhmm,
    recurrence: "daily",
    recurrenceValue: null,
    createdBy: OWNER,
  });

  const { sock, sent } = makeSock();
  await runSchedulerTick(sock);
  const delivered = sent.find((s) => s.jid === chat && (s.content?.text || "").includes("pesan terjadwal"));
  assert.ok(delivered, `schedule not delivered: ${JSON.stringify(sent.map((s) => s.content))}`);
  assert.ok(db.getSchedule(id).lastSentAt, "lastSentAt not recorded");

  // a second tick in the same minute must NOT resend (already fired today)
  const { sock: sock2, sent: sent2 } = makeSock();
  await runSchedulerTick(sock2);
  assert.ok(!sent2.some((s) => s.jid === chat), "schedule fired twice in one day");
});

await test("schedules persist across a database reopen", async () => {
  const { initDatabase, getDatabase } = await import("../lib/database.js");
  const chat = "19001@g.us";
  db.registerGroup(chat, { name: "Sched3", status: "active", activated: true });
  db.createSchedule("sch_persist_1", {
    jid: chat,
    content: "tahan restart",
    sendTime: "23:59",
    recurrence: "daily",
    recurrenceValue: null,
    createdBy: OWNER,
  });
  await db.save();

  // reopen the store from disk and confirm the schedule is still there
  await initDatabase(dbPath);
  const reopened = getDatabase();
  const s = reopened.getSchedule("sch_persist_1");
  assert.ok(s, "schedule lost after reopen");
  assert.equal(s.content, "tahan restart");
});

/* ─────────────────── 20. NSFW moderation (local + remote backends) ─────────────────── */

await test("nsfw local model is available by default", async () => {
  const nsfw = await import("../lib/nsfw.js");
  delete process.env.NSFW_API_URL;
  delete process.env.NSFW_LOCAL_MODEL;
  assert.equal(nsfw.isNsfwDetectorConfigured(), true, "local model should be enabled by default");
});

await test("nsfw local classifier flags a safe image as safe", async () => {
  const nsfw = await import("../lib/nsfw.js");
  const sharp = (await import("sharp")).default;
  const buffer = await sharp({
    create: { width: 224, height: 224, channels: 3, background: { r: 130, g: 130, b: 130 } },
  })
    .jpeg()
    .toBuffer();
  const result = await nsfw.classifyImageBuffer(buffer);
  assert.equal(result.available, true, "local classifier should be available");
  assert.equal(result.isNsfw, false, `grey image should be safe; got score ${result.score}`);
});

await test("nsfw local classifier handles animated media (frame sampling)", async () => {
  const nsfw = await import("../lib/nsfw.js");
  const ffmpeg = (await import("fluent-ffmpeg")).default;
  const ffmpegInstaller = (await import("@ffmpeg-installer/ffmpeg")).default;
  ffmpeg.setFfmpegPath(ffmpegInstaller.path);
  const out = path.join(os.tmpdir(), `gxid-feat-gif-${Date.now()}.gif`);
  await new Promise((resolve, reject) => {
    ffmpeg()
      .input("color=c=gray:s=64x64:d=1")
      .inputFormat("lavfi")
      .outputOptions(["-vf", "fps=2"])
      .output(out)
      .on("end", resolve)
      .on("error", reject)
      .run();
  });
  const buffer = fs.readFileSync(out);
  fs.rmSync(out, { force: true });
  const result = await nsfw.classifyAnimatedBuffer(buffer, "image/gif");
  assert.equal(result.available, true, "animated classifier should be available");
  assert.equal(typeof result.isNsfw, "boolean");
});

await test("nsfw is a no-op when both backends are off", async () => {
  const nsfw = await import("../lib/nsfw.js");
  const prevLocal = process.env.NSFW_LOCAL_MODEL;
  delete process.env.NSFW_API_URL;
  process.env.NSFW_LOCAL_MODEL = "false";
  try {
    assert.equal(nsfw.isNsfwDetectorConfigured(), false, "should be unconfigured");
    const result = await nsfw.classifyImageBuffer(Buffer.from("not-an-image"));
    assert.equal(result.available, false, "must not pretend to classify");
    assert.equal(result.isNsfw, false);
  } finally {
    if (prevLocal === undefined) delete process.env.NSFW_LOCAL_MODEL;
    else process.env.NSFW_LOCAL_MODEL = prevLocal;
  }
});

await test("nsfw remote backend takes precedence and drives deletion", async () => {
  const http = await import("http");
  const nsfw = await import("../lib/nsfw.js");
  const { runModeration } = await import("../lib/moderation.js");
  const sharp = (await import("sharp")).default;

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ nsfw: true, score: 0.99 }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const prevUrl = process.env.NSFW_API_URL;
  process.env.NSFW_API_URL = `http://127.0.0.1:${port}/`;
  try {
    const chat = "20000@g.us";
    db.setGroup(chat, { antinsfw: true });
    const buffer = await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: 10, g: 10, b: 10 } },
    })
      .jpeg()
      .toBuffer();

    const { sock, sent } = makeSock();
    const m = {
      isGroup: true,
      isOwner: false,
      fromMe: false,
      isAdmin: false,
      isBotAdmin: true,
      chat,
      sender: USER,
      key: { remoteJid: chat, id: "NSFWMSG", fromMe: false },
      isImage: true,
      mimetype: "image/jpeg",
      download: async () => buffer,
      groupMetadata: { participants: [{ id: USER, admin: null }] },
    };
    const actioned = await runModeration(m, sock);
    assert.equal(actioned, true, "nsfw image should be actioned");
    const deleted = sent.find((s) => s.content?.delete);
    assert.ok(deleted, "message should be deleted");
  } finally {
    if (prevUrl === undefined) delete process.env.NSFW_API_URL;
    else process.env.NSFW_API_URL = prevUrl;
    await new Promise((r) => server.close(r));
  }
});

await test("antinsfw leaves a safe image alone", async () => {
  const { runModeration } = await import("../lib/moderation.js");
  const sharp = (await import("sharp")).default;
  delete process.env.NSFW_API_URL;
  const chat = "20001@g.us";
  db.setGroup(chat, { antinsfw: true });
  const buffer = await sharp({
    create: { width: 224, height: 224, channels: 3, background: { r: 128, g: 128, b: 128 } },
  })
    .jpeg()
    .toBuffer();
  const { sock, sent } = makeSock();
  const m = {
    isGroup: true,
    isOwner: false,
    fromMe: false,
    isAdmin: false,
    isBotAdmin: true,
    chat,
    sender: USER,
    key: { remoteJid: chat, id: "SAFEMSG", fromMe: false },
    isImage: true,
    mimetype: "image/jpeg",
    download: async () => buffer,
    groupMetadata: { participants: [{ id: USER, admin: null }] },
  };
  const actioned = await runModeration(m, sock);
  assert.equal(actioned, false, "safe image must not be actioned");
  assert.equal(sent.filter((s) => s.content?.delete).length, 0, "must not delete a safe image");
});

/* ─────────────────── 21. group alias system & remote control ─────────────────── */

await test("setgroupalias + alias resolution + uniqueness", async () => {
  const { resolveGroup, setGroupAlias } = await import("../lib/group-registry.js");
  const chat = "21000@g.us";
  db.registerGroup(chat, { name: "Alias A", status: "active", activated: true });

  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".setgroupalias kelas-a", { sender: OWNER, group: chat }), sock);
  assert.ok(textOf(sent).includes("kelas-a"), `got: ${textOf(sent)}`);

  assert.equal(resolveGroup("kelas-a")?.groupId, chat, "alias must resolve to the group");
  assert.equal(resolveGroup("KELAS-A")?.groupId, chat, "alias lookup must be case-insensitive");
  assert.equal(resolveGroup("21000")?.groupId, chat, "bare internal id must resolve");

  // a second group cannot steal the alias
  const chat2 = "21001@g.us";
  db.registerGroup(chat2, { name: "Alias B", status: "active", activated: true });
  const res = setGroupAlias(chat2, "kelas-a");
  assert.equal(res.ok, false, "duplicate alias must be rejected");
});

await test("setgroupalias rejects an invalid alias", async () => {
  const chat = "21002@g.us";
  db.registerGroup(chat, { name: "Alias C", status: "active", activated: true });
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".setgroupalias Bad_Alias!", { sender: OWNER, group: chat }), sock);
  assert.ok(textOf(sent).toLowerCase().includes("tidak valid"), `got: ${textOf(sent)}`);
});

await test("remote registergroup by id + alias from outside the group", async () => {
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".registergroup remote-x 21010@g.us", { sender: OWNER, group: null }), sock);
  assert.ok(textOf(sent).includes("didaftarkan"), `got: ${textOf(sent)}`);
  const reg = db.getRegistration("21010@g.us");
  assert.ok(reg, "remote registration not stored");
  assert.equal(reg.alias, "remote-x");
});

await test("remote registergroup is denied for a non-owner", async () => {
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".registergroup remote-y 21011@g.us", { sender: USER, group: null }), sock);
  assert.ok(textOf(sent).toLowerCase().includes("owner"), `got: ${textOf(sent)}`);
  assert.ok(!db.getRegistration("21011@g.us"), "non-owner must not register");
});

await test("remote control by alias from a private chat (owner)", async () => {
  const chat = "21020@g.us";
  db.registerGroup(chat, { name: "Remote Toggle", status: "active", activated: true });
  const { setGroupAlias } = await import("../lib/group-registry.js");
  setGroupAlias(chat, "remote-t");

  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".antilink remote-t on", { sender: OWNER, group: null }), sock);
  assert.ok(textOf(sent).includes("diaktifkan"), `got: ${textOf(sent)}`);
  assert.equal(db.getGroup(chat)?.antilink, true, "remote toggle not persisted to the target group");
});

await test("remote control by plain user is denied", async () => {
  const chat = "21021@g.us";
  db.registerGroup(chat, { name: "Remote Denied", status: "active", activated: true });
  const { setGroupAlias } = await import("../lib/group-registry.js");
  setGroupAlias(chat, "remote-d");

  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".antilink remote-d on", { sender: USER, group: null }), sock);
  assert.ok(textOf(sent).toLowerCase().includes("izin") || textOf(sent).toLowerCase().includes("admin"), `got: ${textOf(sent)}`);
  assert.notEqual(db.getGroup(chat)?.antilink, true, "plain user must not change a remote group");
});

await test("admin of the target group may manage it remotely", async () => {
  const chat = "21022@g.us";
  db.registerGroup(chat, { name: "Remote Admin", status: "active", activated: true });
  const { setGroupAlias } = await import("../lib/group-registry.js");
  setGroupAlias(chat, "remote-a");

  // ADMIN is a group admin per the mock metadata
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".antilink remote-a on", { sender: ADMIN, group: null }), sock);
  assert.ok(textOf(sent).includes("diaktifkan"), `got: ${textOf(sent)}`);
  assert.equal(db.getGroup(chat)?.antilink, true, "target admin must be able to manage remotely");
});

await test("unregistered remote target is rejected", async () => {
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".antilink 999888777@g.us on", { sender: OWNER, group: null }), sock);
  assert.ok(textOf(sent).toLowerCase().includes("belum terdaftar"), `got: ${textOf(sent)}`);
});

await test("missing target from a private chat errors clearly", async () => {
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".antilink on", { sender: OWNER, group: null }), sock);
  assert.ok(textOf(sent).toLowerCase().includes("belum ditentukan"), `got: ${textOf(sent)}`);
});

/* ─────────────────── 22. feature-scoped links (shared data) ─────────────────── */

await test("link notes shares notes between groups (no copy)", async () => {
  const a = "22000@g.us";
  const b = "22001@g.us";
  db.registerGroup(a, { name: "Share A", status: "active", activated: true });
  db.registerGroup(b, { name: "Share B", status: "active", activated: true });
  const { setGroupAlias } = await import("../lib/group-registry.js");
  setGroupAlias(a, "share-a");
  setGroupAlias(b, "share-b");

  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".link notes share-a share-b", { sender: OWNER, group: null }), sock);
  assert.ok(textOf(sent).includes("dibagikan"), `link: ${textOf(sent)}`);

  const { resolveScopeId } = await import("../lib/group-scope.js");
  assert.equal(resolveScopeId("notes", a), resolveScopeId("notes", b), "linked groups must share a scope");

  // write via A, read via B
  const { sock: s2 } = makeSock();
  await messageHandler(rawMsg(".addnote share-a bersama Isi bersama", { sender: OWNER, group: null }), s2);
  const scope = resolveScopeId("notes", a);
  assert.ok(db.getNote(scope, "bersama"), "note not stored in the shared scope");

  const { sock: s3, sent: sent3 } = makeSock();
  await messageHandler(rawMsg("#bersama", { sender: USER, group: b }), s3);
  assert.ok(textOf(sent3).includes("Isi bersama"), `shared read failed: ${textOf(sent3)}`);
});

await test("unlink notes stops sharing", async () => {
  const a = "22010@g.us";
  const b = "22011@g.us";
  db.registerGroup(a, { name: "Unshare A", status: "active", activated: true });
  db.registerGroup(b, { name: "Unshare B", status: "active", activated: true });
  const { setGroupAlias } = await import("../lib/group-registry.js");
  setGroupAlias(a, "unshare-a");
  setGroupAlias(b, "unshare-b");

  let { sock } = makeSock();
  await messageHandler(rawMsg(".link notes unshare-a unshare-b", { sender: OWNER, group: null }), sock);
  ({ sock } = makeSock());
  await messageHandler(rawMsg(".unlink notes unshare-a unshare-b", { sender: OWNER, group: null }), sock);

  const { resolveScopeId } = await import("../lib/group-scope.js");
  assert.notEqual(resolveScopeId("notes", a), resolveScopeId("notes", b), "scopes must separate after unlink");
});

await test("peer link is bidirectional and shows in .links", async () => {
  const a = "22020@g.us";
  const b = "22021@g.us";
  db.registerGroup(a, { name: "Peer A", status: "active", activated: true });
  db.registerGroup(b, { name: "Peer B", status: "active", activated: true });
  const { setGroupAlias } = await import("../lib/group-registry.js");
  setGroupAlias(a, "peer-a");
  setGroupAlias(b, "peer-b");

  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".link peer-a peer-b", { sender: OWNER, group: null }), sock);
  assert.ok(textOf(sent).includes("terhubung"), `got: ${textOf(sent)}`);
  assert.ok(db.isLinked(a, b) && db.isLinked(b, a), "peer link must be bidirectional");
});

await test("listreg shows the alias first (id hidden in normal UI)", async () => {
  const a = "22030@g.us";
  db.registerGroup(a, { name: "List Alias", status: "active", activated: true });
  const { setGroupAlias } = await import("../lib/group-registry.js");
  setGroupAlias(a, "list-alias");

  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".listreg", { sender: OWNER, group: null }), sock);
  const text = textOf(sent);
  assert.ok(!sent.find((s) => s.relayed), "listreg must render as plain text, not a flow");
  assert.ok(text.includes("list-alias"), `alias missing: ${text}`);
  assert.ok(text.includes("22030@g.us"), `id missing: ${text}`);
});

await test(".logs renders recent events and sets retention", async () => {
  const chat = "22040@g.us";
  db.registerGroup(chat, { name: "Logs Group", status: "active", activated: true });
  db.setGroup(chat, { antilink: true });
  const { sock: s0 } = makeSock();
  await messageHandler(rawMsg("cek https://spam.example.com", { sender: USER, group: chat }), s0);

  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".logs", { sender: OWNER, group: null }), sock);
  assert.ok(textOf(sent).includes("Log Moderasi"), `got: ${textOf(sent)}`);

  const { sock: s2, sent: sent2 } = makeSock();
  await messageHandler(rawMsg(".logs retention 30", { sender: OWNER, group: null }), s2);
  assert.ok(textOf(sent2).includes("30"), `got: ${textOf(sent2)}`);
  const { getLogRetentionDays } = await import("../lib/moderation-log.js");
  assert.equal(getLogRetentionDays(), 30);
  // restore the default so later runs are unaffected
  const { setLogRetentionDays } = await import("../lib/moderation-log.js");
  setLogRetentionDays(14);
});

await test("registergroup by id fetches the group name", async () => {
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".registergroup 21050@g.us", { sender: OWNER, group: null }), sock);
  const reg = db.getRegistration("21050@g.us");
  assert.ok(reg, "not registered by id");
  assert.ok(reg.name, `name not fetched: ${JSON.stringify(reg.name)}`);
  assert.ok(textOf(sent).includes(reg.name), `reply missing name: ${textOf(sent)}`);
});

await test("unregistergroup works by bare id", async () => {
  const chat = "21051@g.us";
  db.registerGroup(chat, { name: "Unreg By Id", status: "active", activated: true });
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".unregistergroup 21051", { sender: OWNER, group: null }), sock);
  assert.ok(textOf(sent).includes("dinonaktifkan"), `got: ${textOf(sent)}`);
  assert.equal(db.getRegistration(chat), null, "registration must be removed");
});

await test("revoked media is forwarded to an external log panel", async () => {
  const src = "21060@g.us";
  const panel = "21061@g.us";
  db.registerGroup(src, { name: "Forward Src", status: "active", activated: true });
  db.registerGroup(panel, { name: "Forward Panel", status: "active", activated: true });
  db.setRegistrationLogPanel(src, panel);

  const { rememberMessage } = await import("../lib/recent-messages.js");
  const buf = Buffer.from("PHOTO_BYTES_TEST");
  await rememberMessage(
    { chat: src, id: "FWD_IMG", body: "foto rahasia", sender: USER, type: "imageMessage", download: async () => buf },
    { cacheMedia: true, mediaType: "image", mimetype: "image/jpeg" },
  );

  const { sock, sent } = makeSock();
  await messageHandler(
    {
      key: { remoteJid: src, fromMe: false, id: "FWD_REV", participant: USER },
      message: { protocolMessage: { type: 0, key: { id: "FWD_IMG", remoteJid: src } } },
      messageTimestamp: Math.floor(Date.now() / 1000),
    },
    sock,
  );

  const forwarded = sent.find((s) => s.jid === panel && s.content?.image);
  assert.ok(forwarded, `media not forwarded: ${JSON.stringify(sent.map((s) => s.jid))}`);
  assert.equal(forwarded.content.image.toString(), buf.toString(), "forwarded bytes must match");
  assert.ok((forwarded.content.caption || "").includes("REVOKED"), `caption: ${forwarded.content.caption}`);
  // the source group must NOT get a duplicate notice (panel is external)
  assert.ok(!sent.some((s) => s.jid === src), "source group should stay quiet");
});

await test("revoked text is forwarded to an external log panel as text", async () => {
  const src = "21070@g.us";
  const panel = "21071@g.us";
  db.registerGroup(src, { name: "Text Src", status: "active", activated: true });
  db.registerGroup(panel, { name: "Text Panel", status: "active", activated: true });
  db.setRegistrationLogPanel(src, panel);

  const { rememberMessage } = await import("../lib/recent-messages.js");
  rememberMessage({ chat: src, id: "FWD_TXT", body: "pesan teks rahasia", sender: USER, type: "conversation" });

  const { sock, sent } = makeSock();
  await messageHandler(
    {
      key: { remoteJid: src, fromMe: false, id: "FWD_REV2", participant: USER },
      message: { protocolMessage: { type: 0, key: { id: "FWD_TXT", remoteJid: src } } },
      messageTimestamp: Math.floor(Date.now() / 1000),
    },
    sock,
  );

  const forwarded = sent.find((s) => s.jid === panel);
  assert.ok(forwarded, "text revoke not forwarded");
  assert.ok((forwarded.content?.text || "").includes("REVOKED"), `got: ${forwarded.content?.text}`);
  assert.ok((forwarded.content?.text || "").includes("pesan teks rahasia"), "content missing");
});

/* ─────────────────── 23. moderation event logger ─────────────────── */

await test("moderation deletion is recorded in the event log", async () => {
  const chat = "23000@g.us";
  db.registerGroup(chat, { name: "Log Group", status: "active", activated: true });
  db.setGroup(chat, { antilink: true });
  const before = db.eventLogCount();

  const { sock } = makeSock();
  await messageHandler(rawMsg("cek https://spam.example.com", { sender: USER, group: chat }), sock);

  assert.ok(db.eventLogCount() > before, "an event should be logged");
  const event = db.listEventLogs(5, { groupId: chat })[0];
  assert.equal(event.action, "delete");
  assert.equal(event.reason, "antilink");
  assert.equal(event.actorId, USER);
});

await test("log panel receives a formatted notice", async () => {
  const chat = "23001@g.us";
  const panel = "23002@g.us";
  db.registerGroup(chat, { name: "Panel Src", status: "active", activated: true });
  db.registerGroup(panel, { name: "Panel Dst", status: "active", activated: true });
  const { setGroupAlias } = await import("../lib/group-registry.js");
  setGroupAlias(chat, "panel-src");
  setGroupAlias(panel, "panel-dst");
  db.setGroup(chat, { antilink: true });

  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".log set panel-src panel-dst", { sender: OWNER, group: null }), sock);
  assert.equal(db.getRegistration(chat)?.logPanel, panel, "log panel not stored");

  const { sock: s2, sent: sent2 } = makeSock();
  await messageHandler(rawMsg("link https://spam.example.com", { sender: USER, group: chat }), s2);
  const notice = sent2.find((s) => s.jid === panel && (s.content?.text || "").includes("GX-ID LOG"));
  assert.ok(notice, `panel notice missing: ${JSON.stringify(sent2.map((s) => s.jid))}`);
});

await test("revoke is logged with the cached content", async () => {
  const chat = "23010@g.us";
  db.registerGroup(chat, { name: "Revoke Group", status: "active", activated: true });
  const { rememberMessage } = await import("../lib/recent-messages.js");
  rememberMessage({ chat, id: "REVOKE_ME", body: "pesan rahasia", sender: USER, type: "conversation" });

  const before = db.eventLogCount();
  const { sock } = makeSock();
  await messageHandler(
    {
      key: { remoteJid: chat, fromMe: false, id: "REV_MSG", participant: USER },
      message: { protocolMessage: { type: 0, key: { id: "REVOKE_ME", remoteJid: chat } } },
      messageTimestamp: Math.floor(Date.now() / 1000),
    },
    sock,
  );

  assert.ok(db.eventLogCount() > before, "revoke should be logged");
  const event = db.listEventLogs(5, { groupId: chat })[0];
  assert.equal(event.action, "revoked");
  assert.equal(event.contentPreview, "pesan rahasia");
});

await test("log retention prunes old events", async () => {
  const db2 = db;
  db2.addEventLog({ id: "old-evt-1", type: "moderation", action: "delete", createdAt: "2000-01-01T00:00:00.000Z" });
  const { pruneEventLogs } = await import("../lib/moderation-log.js");
  pruneEventLogs();
  const remaining = db2.listEventLogs(0).some((e) => e.id === "old-evt-1");
  assert.equal(remaining, false, "old events must be pruned");
});

/* ─────────────────── 24. ambiguous-arg resolution ─────────────────── */

await test("addfilter distinguishes target+trigger from trigger only", async () => {
  const a = "24000@g.us";
  const b = "24001@g.us";
  db.registerGroup(a, { name: "Arg A", status: "active", activated: true });
  db.registerGroup(b, { name: "Arg B", status: "active", activated: true });
  const { setGroupAlias } = await import("../lib/group-registry.js");
  setGroupAlias(a, "arg-a");

  // `.addfilter arg-a halo Halo!` → target=arg-a, trigger=halo
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".addfilter arg-a halo Halo!", { sender: OWNER, group: null }), sock);
  assert.ok(db.listFilters(a).some((f) => f.trigger === "halo"), `target+trigger failed: ${textOf(sent)}`);

  // `.addfilter kabar Kabar baik` (in group b) → trigger=kabar for the CURRENT group
  const { sock: s2 } = makeSock();
  await messageHandler(rawMsg(".addfilter kabar Kabar baik", { sender: ADMIN, group: b }), s2);
  assert.ok(db.listFilters(b).some((f) => f.trigger === "kabar"), "current-group trigger failed");
  assert.ok(!db.listFilters(a).some((f) => f.trigger === "kabar"), "must not leak to the other group");
});

/* ─────────────────── 25. no-secret guarantees for the new modules ─────────────────── */

await test("new modules expose no hardcoded credentials", async () => {
  const files = [
    "../lib/group-registry.js",
    "../lib/group-scope.js",
    "../lib/moderation-log.js",
    "../lib/recent-messages.js",
    "../lib/group-id.js",
    "../lib/flow-context.js",
  ];
  for (const f of files) {
    const src = fs.readFileSync(new URL(f, import.meta.url), "utf8");
    assert.ok(!/sk-[A-Za-z0-9]{10,}/.test(src), `possible secret in ${f}`);
    assert.ok(!/AIza[0-9A-Za-z_-]{20,}/.test(src), `possible google key in ${f}`);
  }
});

/* ─────────────────── 26. .del + log scope + .rvo scope ─────────────────── */

await test(".del deletes the replied message and logs it", async () => {
  const chat = "26000@g.us";
  const panel = "26001@g.us";
  db.registerGroup(chat, { name: "Del Src", status: "active", activated: true });
  db.registerGroup(panel, { name: "Del Panel", status: "active", activated: true });
  db.setRegistrationLogPanel(chat, panel);

  const { sock, sent } = makeSock();
  const before = db.eventLogCount();
  // ADMIN replies to USER's message with `.del`
  await messageHandler(rawMsg(".del", { sender: ADMIN, group: chat, quoted: "pesan yang mau dihapus" }), sock);

  assert.ok(db.eventLogCount() > before, "deletion must be logged");
  const event = db.listEventLogs(5, { groupId: chat })[0];
  assert.equal(event.action, "delete");
  assert.equal(event.reason, "del");
  assert.equal(event.contentPreview, "pesan yang mau dihapus");
  // the deleted message AND the trigger are both revoked
  const deletes = sent.filter((s) => s.content?.delete);
  assert.ok(deletes.length >= 1, `no delete call: ${JSON.stringify(sent.map((s) => Object.keys(s.content || {})))}`);
  // the panel receives a formatted notice
  const notice = sent.find((s) => s.jid === panel && (s.content?.text || "").includes("GX-ID LOG"));
  assert.ok(notice, "panel notice missing for .del");
});

await test(".del requires a reply", async () => {
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".del", { sender: ADMIN, group: "26010@g.us" }), sock);
  assert.ok(textOf(sent).includes("Balas"), `got: ${textOf(sent)}`);
});

await test("log scope public forwards non-registered group logs to the default panel", async () => {
  const { setLogScope, setDefaultLogPanel, getLogScope, getDefaultLogPanel } = await import("../lib/settings.js");
  const chat = "26020@g.us"; // NOT registered
  const panel = "26021@g.us";
  db.registerGroup(panel, { name: "Global Panel", status: "active", activated: true });
  db.setGroup(chat, { antilink: true });

  const prevScope = getLogScope();
  const prevPanel = getDefaultLogPanel();
  try {
    setLogScope("registered");
    setDefaultLogPanel(panel);

    // registered scope → unregistered group is silent (event persisted only)
    let { sock, sent } = makeSock();
    await messageHandler(rawMsg("link https://spam.example.com", { sender: USER, group: chat }), sock);
    assert.ok(!sent.some((s) => s.jid === panel), "registered scope must not forward non-registered group");

    // public scope → forwarded to the default panel
    setLogScope("public");
    ({ sock, sent } = makeSock());
    await messageHandler(rawMsg("link https://spam.example.com", { sender: USER, group: chat }), sock);
    const notice = sent.find((s) => s.jid === panel && (s.content?.text || "").includes("GX-ID LOG"));
    assert.ok(notice, `public scope should forward to default panel: ${JSON.stringify(sent.map((s) => s.jid))}`);
  } finally {
    setLogScope(prevScope);
    setDefaultLogPanel(prevPanel);
  }
});

await test(".rvo is blocked outside registered groups by default", async () => {
  const { setRvoScope, getRvoScope } = await import("../lib/settings.js");
  const prev = getRvoScope();
  try {
    setRvoScope("registered");
    const { sock, sent } = makeSock();
    await messageHandler(rawMsg(".rvo", { sender: USER, group: "26030@g.us" }), sock);
    assert.ok(textOf(sent).includes("grup terdaftar"), `got: ${textOf(sent)}`);
  } finally {
    setRvoScope(prev);
  }
});

await test("rvo scope public allows .rvo outside registered groups", async () => {
  const { setRvoScope, getRvoScope } = await import("../lib/settings.js");
  const prev = getRvoScope();
  try {
    setRvoScope("public");
    const { sock, sent } = makeSock();
    // no reply → the "reply a view-once" hint, NOT the scope denial
    await messageHandler(rawMsg(".rvo", { sender: USER, group: "26040@g.us" }), sock);
    assert.ok(!textOf(sent).includes("grup terdaftar"), `public scope must not deny: ${textOf(sent)}`);
  } finally {
    setRvoScope(prev);
  }
});

await test(".log scope / .log rvo report and set the mode", async () => {
  const { getLogScope, setLogScope, getRvoScope, setRvoScope } = await import("../lib/settings.js");
  const prevLog = getLogScope();
  const prevRvo = getRvoScope();
  try {
    let { sock, sent } = makeSock();
    await messageHandler(rawMsg(".log scope public", { sender: OWNER, group: null }), sock);
    assert.equal(getLogScope(), "public");
    assert.ok(textOf(sent).includes("PUBLIC"), `got: ${textOf(sent)}`);

    ({ sock, sent } = makeSock());
    await messageHandler(rawMsg(".log rvo public", { sender: OWNER, group: null }), sock);
    assert.equal(getRvoScope(), "public");

    ({ sock, sent } = makeSock());
    await messageHandler(rawMsg(".log scope", { sender: OWNER, group: null }), sock);
    assert.ok(textOf(sent).includes("Log Scope"), `got: ${textOf(sent)}`);

    ({ sock, sent } = makeSock());
    await messageHandler(rawMsg(".log scope nope", { sender: OWNER, group: null }), sock);
    assert.ok(textOf(sent).includes("tidak valid"), `got: ${textOf(sent)}`);

    /* back-compat: the old top-level aliases still work */
    ({ sock, sent } = makeSock());
    await messageHandler(rawMsg(".logscope registered", { sender: OWNER, group: null }), sock);
    assert.equal(getLogScope(), "registered");
    ({ sock, sent } = makeSock());
    await messageHandler(rawMsg(".rvoscope registered", { sender: OWNER, group: null }), sock);
    assert.equal(getRvoScope(), "registered");
  } finally {
    setLogScope(prevLog);
    setRvoScope(prevRvo);
  }
});

await test(".log set / reset / default manage the panel", async () => {
  const { getDefaultLogPanel, setDefaultLogPanel } = await import("../lib/settings.js");
  const src = "26050@g.us";
  const panel = "26051@g.us";
  db.registerGroup(src, { name: "Log Src", status: "active", activated: true });
  db.registerGroup(panel, { name: "Log Panel", status: "active", activated: true });
  const { setGroupAlias } = await import("../lib/group-registry.js");
  setGroupAlias(src, "log-src");
  setGroupAlias(panel, "log-panel");

  const prevPanel = getDefaultLogPanel();
  try {
    // `.log default <panel>` sets the global default
    let { sock, sent } = makeSock();
    await messageHandler(rawMsg(".log default log-panel", { sender: OWNER, group: null }), sock);
    assert.equal(getDefaultLogPanel(), panel, `got: ${textOf(sent)}`);

    // registered group with no explicit panel now forwards to the global default
    const { getLogPanel } = await import("../lib/moderation-log.js");
    assert.equal(getLogPanel(src), panel, "registered group should default to the global panel");

    // `.log set <grup>` pins an explicit panel
    ({ sock, sent } = makeSock());
    await messageHandler(rawMsg(".log set log-src", { sender: OWNER, group: panel }), sock);
    assert.equal(db.getRegistration(src)?.logPanel, panel, "explicit panel not stored");

    // `.log reset <grup>` clears it (back to the global default)
    ({ sock, sent } = makeSock());
    await messageHandler(rawMsg(".log reset log-src", { sender: OWNER, group: null }), sock);
    assert.equal(db.getRegistration(src)?.logPanel, null, "panel should be cleared");

    // `.log` with no args shows the status
    ({ sock, sent } = makeSock());
    await messageHandler(rawMsg(".log", { sender: OWNER, group: null }), sock);
    assert.ok(textOf(sent).includes("Log Panel"), `got: ${textOf(sent)}`);
  } finally {
    setDefaultLogPanel(prevPanel);
  }
});

await test("registering a group defaults its log to the global panel", async () => {
  const { setDefaultLogPanel, getDefaultLogPanel, getLogScope, setLogScope } = await import("../lib/settings.js");
  const { getLogPanel } = await import("../lib/moderation-log.js");
  const chat = "26060@g.us";
  const panel = "26061@g.us";
  db.registerGroup(panel, { name: "Reg Panel", status: "active", activated: true });

  const prevPanel = getDefaultLogPanel();
  const prevScope = getLogScope();
  try {
    setLogScope("registered");
    setDefaultLogPanel(panel);

    // register a fresh group via the command, then verify its panel is the global one
    const { sock } = makeSock();
    await messageHandler(rawMsg(".registergroup", { sender: OWNER, group: chat }), sock);
    assert.ok(db.getRegistration(chat), "group should be registered");
    assert.equal(getLogPanel(chat), panel, "newly registered group must log to the global panel");
  } finally {
    setDefaultLogPanel(prevPanel);
    setLogScope(prevScope);
    db.unregisterGroup(chat);
  }
});

/* ─────────────────── 27. plain-text lists + global scope + .notes all / .links all ─────────────────── */

await test("filters / schedules / blacklists render as plain text", async () => {
  const chat = "27000@g.us";
  db.registerGroup(chat, { name: "Plain Lists", status: "active", activated: true });
  db.setFilter(chat, "hello", { content: "hi", createdBy: ADMIN });
  db.addBlacklist(chat, "spam", ADMIN);
  db.createSchedule(`sch_plain_${Date.now().toString(36)}`, {
    jid: chat,
    content: "pesan",
    sendTime: "08:00",
    recurrence: "daily",
  });

  for (const cmd of [".filters", ".schedules", ".blacklists"]) {
    const { sock, sent } = makeSock();
    await messageHandler(rawMsg(cmd, { sender: ADMIN, group: chat }), sock);
    assert.ok(!sent.find((s) => s.relayed), `${cmd} must not send a flow`);
    assert.ok(textOf(sent).length > 0, `${cmd} produced no text`);
  }
});

await test("global notes are visible in every group and overlay own notes", async () => {
  const g1 = "27100@g.us";
  const g2 = "27101@g.us";
  db.registerGroup(g1, { name: "G1", status: "active", activated: true });
  db.registerGroup(g2, { name: "G2", status: "active", activated: true });

  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".addnote global rules Bersikap baik!", { sender: OWNER, group: null }), sock);
  assert.ok(textOf(sent).includes("saved") || textOf(sent).includes("disimpan"), `got: ${textOf(sent)}`);

  // visible via the # shortcut in both groups
  for (const g of [g1, g2]) {
    const { sock: s, sent: st } = makeSock();
    await messageHandler(rawMsg("#rules", { sender: USER, group: g }), s);
    assert.ok(textOf(st).includes("Bersikap baik!"), `global note missing in ${g}: ${textOf(st)}`);
  }

  // a group's own note with the same name wins
  const { sock: s2 } = makeSock();
  await messageHandler(rawMsg(".addnote rules Local rule", { sender: ADMIN, group: g1 }), s2);
  const { sock: s3, sent: st3 } = makeSock();
  await messageHandler(rawMsg("#rules", { sender: USER, group: g1 }), s3);
  assert.ok(textOf(st3).includes("Local rule"), `own note must win: ${textOf(st3)}`);
  const { sock: s4, sent: st4 } = makeSock();
  await messageHandler(rawMsg("#rules", { sender: USER, group: g2 }), s4);
  assert.ok(textOf(st4).includes("Bersikap baik!"), `global note must still apply elsewhere: ${textOf(st4)}`);
});

await test("global filters and blacklists apply in every group", async () => {
  const g1 = "27200@g.us";
  const g2 = "27201@g.us";
  db.registerGroup(g1, { name: "GF1", status: "active", activated: true });
  db.registerGroup(g2, { name: "GF2", status: "active", activated: true });

  const { sock } = makeSock();
  await messageHandler(rawMsg(".addfilter global ping PONG-GLOBAL", { sender: OWNER, group: null }), sock);
  const { sock: s2, sent: st2 } = makeSock();
  await messageHandler(rawMsg("ping", { sender: USER, group: g2 }), s2);
  assert.ok(st2.some((s) => (s.content?.text || "").includes("PONG-GLOBAL")), `global filter did not fire: ${textOf(st2)}`);

  const { sock: s3 } = makeSock();
  await messageHandler(rawMsg(".blacklist global judi", { sender: OWNER, group: null }), s3);
  const { listEffectiveBlacklist } = await import("../lib/group-scope.js");
  assert.ok(listEffectiveBlacklist(db, g1).some((e) => e.entry === "judi"), "global blacklist must apply to g1");
  assert.ok(listEffectiveBlacklist(db, g2).some((e) => e.entry === "judi"), "global blacklist must apply to g2");
});

await test("non-owner cannot write global data", async () => {
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".addnote global secret nope", { sender: ADMIN, group: "27300@g.us" }), sock);
  assert.ok(textOf(sent).includes("owner"), `got: ${textOf(sent)}`);
});

await test(".notes global and .notes all list stored notes", async () => {
  const g1 = "27400@g.us";
  const g2 = "27401@g.us";
  db.registerGroup(g1, { name: "N1", status: "active", activated: true });
  db.registerGroup(g2, { name: "N2", status: "active", activated: true });
  const { setGroupAlias } = await import("../lib/group-registry.js");
  setGroupAlias(g1, "notes-n1");

  const { sock } = makeSock();
  await messageHandler(rawMsg(".addnote global gnote Global note body", { sender: OWNER, group: null }), sock);
  const { sock: s2 } = makeSock();
  await messageHandler(rawMsg(".addnote alpha Alpha body", { sender: ADMIN, group: g1 }), s2);
  const { sock: s3 } = makeSock();
  await messageHandler(rawMsg(".addnote beta Beta body", { sender: ADMIN2, group: g2 }), s3);

  // .notes global
  const { sock: s4, sent: st4 } = makeSock();
  await messageHandler(rawMsg(".notes global", { sender: USER, group: g1 }), s4);
  assert.ok(textOf(st4).includes("gnote"), `global list missing gnote: ${textOf(st4)}`);

  // .notes all (owner) — grouped per group
  const { sock: s5, sent: st5 } = makeSock();
  await messageHandler(rawMsg(".notes all", { sender: OWNER, group: null }), s5);
  const all = textOf(st5);
  assert.ok(all.includes("alpha") && all.includes("beta") && all.includes("gnote"), `notes all incomplete: ${all}`);
  assert.ok(all.includes("notes-n1"), `notes all must group by alias: ${all}`);

  // .notes all denied for non-owner
  const { sock: s6, sent: st6 } = makeSock();
  await messageHandler(rawMsg(".notes all", { sender: ADMIN2, group: g1 }), s6);
  assert.ok(textOf(st6).includes("owner"), `notes all should be owner-only: ${textOf(st6)}`);
});

await test(".notes <alias> shows that group's notes", async () => {
  const g1 = "27500@g.us";
  db.registerGroup(g1, { name: "NA", status: "active", activated: true });
  const { setGroupAlias } = await import("../lib/group-registry.js");
  setGroupAlias(g1, "notes-alias");

  const { sock } = makeSock();
  await messageHandler(rawMsg(".addnote special Special body", { sender: ADMIN, group: g1 }), sock);

  const { sock: s2, sent: st2 } = makeSock();
  await messageHandler(rawMsg(".notes notes-alias", { sender: OWNER, group: null }), s2);
  assert.ok(textOf(st2).includes("special"), `alias-target notes missing: ${textOf(st2)}`);
});

await test(".links all lists every linked group", async () => {
  const a = "27600@g.us";
  const b = "27601@g.us";
  db.registerGroup(a, { name: "LA", status: "active", activated: true });
  db.registerGroup(b, { name: "LB", status: "active", activated: true });
  db.linkGroup(a, b);

  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".links all", { sender: OWNER, group: null }), sock);
  const text = textOf(sent);
  assert.ok(text.includes("27601@g.us"), `links all missing target: ${text}`);

  const { sock: s2, sent: st2 } = makeSock();
  await messageHandler(rawMsg(".links all", { sender: ADMIN, group: null }), s2);
  assert.ok(textOf(st2).includes("owner"), `links all should be owner-only: ${textOf(st2)}`);
});

/* ─────────────────── 27. self-update (.update / .checkupdate) ─────────────────── */

await test("update command is owner-only", async () => {
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".checkupdate", { sender: USER, group: null }), sock);
  assert.ok(textOf(sent).toLowerCase().includes("owner"), `got: ${textOf(sent)}`);
});

await test(".checkupdate reports unconfigured when GITHUB_REPO is unset", async () => {
  const { isConfigured } = await import("../lib/updater.js");
  assert.equal(isConfigured(), false, "tests must run without GITHUB_REPO");
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".checkupdate", { sender: OWNER, group: null }), sock);
  const text = textOf(sent);
  assert.ok(text.includes("GITHUB_REPO"), `got: ${text}`);
  assert.ok(text.toLowerCase().includes("belum dikonfigurasi"), `got: ${text}`);
});

await test(".update bare is treated as apply (not a usage card)", async () => {
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".update", { sender: OWNER, group: null }), sock);
  const text = textOf(sent);
  /* helpOnEmpty:false → bare `.update` runs; unconfigured → the GITHUB_REPO hint */
  assert.ok(text.includes("GITHUB_REPO"), `bare .update should run the handler: ${text}`);
  assert.ok(!text.includes("Parameter tersedia"), "bare .update must not show the usage card");
});

await test(".update help renders the usage card", async () => {
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".update help", { sender: OWNER, group: null }), sock);
  const text = textOf(sent);
  assert.ok(text.includes("Parameter tersedia"), `got: ${text}`);
  assert.ok(text.includes("check"), `got: ${text}`);
});

/* ─────────────────── report ─────────────────── */

for (const r of results) console.log(`${r.ok ? "✓" : "✗"} ${r.name}${r.ok ? "" : ` — ${r.error}`}`);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} feature checks passed`);
try {
  fs.writeFileSync(path.join(process.cwd(), "features-report.json"), JSON.stringify(results, null, 2));
} catch {
  /* ignore */
}
fs.rmSync(dbPath, { recursive: true, force: true });
if (failed.length) process.exit(1);
process.exit(0);
