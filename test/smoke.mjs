/**
 * GX-ID — smoke test
 *
 * Verifies that all core modules import cleanly, the database initializes,
 * plugins load and register, and the case system is wired up. Run with:
 *   node test/smoke.mjs
 */
import assert from "assert";
import path from "path";
import fs from "fs";

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
  }
}

async function main() {
  // config + helpers
  const { default: config, isOwner, isBanned, cleanNumber } = await import("../config.js");
  check("config loads", () => {
    assert.equal(typeof config.bot.name, "string");
    assert.equal(typeof config.command.prefix, "string");
  });
  check("config.cleanNumber", () => {
    assert.equal(cleanNumber("62812-345:5@s.whatsapp.net"), "62812345");
  });

  // logger
  const { logger } = await import("../lib/logger.js");
  check("logger has tags", () => {
    for (const t of ["info", "error", "command", "plugin", "group", "database", "api"]) {
      assert.equal(typeof logger[t], "function", `missing logger.${t}`);
    }
  });

  // time
  const time = await import("../lib/time.js");
  check("time helpers", () => {
    assert.equal(typeof time.formatTime(), "string");
    assert.equal(typeof time.getTimeGreeting(), "string");
  });

  // formatter
  const fmt = await import("../lib/formatter.js");
  check("formatter helpers", () => {
    assert.equal(typeof fmt.toSmallCaps("abc"), "string");
    assert.equal(typeof fmt.formatUptime(1000), "string");
    assert.equal(typeof fmt.formatFileSize(1024), "string");
  });

  // database
  const dbPath = path.join(process.cwd(), "database", "smoke-test");
  const { initDatabase, getDatabase } = await import("../lib/database.js");
  await checkAsync("database init", async () => {
    const db = await initDatabase(dbPath);
    assert.ok(db);
    db.setUser("628111@s.whatsapp.net", { name: "Tester" });
    const u = db.getUser("628111@s.whatsapp.net");
    assert.equal(u.name, "Tester");
    db.setNote("g@g.us", "rules", "be nice", "628111");
    assert.equal(db.getNote("g@g.us", "rules").content, "be nice");
    assert.equal(db.listNotes("g@g.us").length, 1);
    db.deleteNote("g@g.us", "rules");
    assert.equal(db.listNotes("g@g.us").length, 0);
    db.setting("testKey", "value");
    assert.equal(db.setting("testKey"), "value");
    db.setCooldown("628111", "test", 5);
    assert.ok(db.checkCooldown("628111", "test", 5) > 0);
  });

  // context
  const ctx = await import("../lib/context.js");
  check("context helpers", () => {
    const c = ctx.saluranCtx();
    assert.equal(typeof c, "object");
    assert.ok(ctx.interactiveContextInfo().messageSecret);
  });
  check("interactiveContextInfo includes messageSecret", () => {
    const ci = ctx.interactiveContextInfo();
    assert.ok(Buffer.isBuffer(ci.messageSecret), "messageSecret must be a Buffer");
    assert.equal(ci.messageSecret.length, 32, "messageSecret must be 32 bytes");
    assert.equal(ci.deviceListMetadataVersion, 2);
  });

  // serialize helpers
  const ser = await import("../lib/serialize.js");
  check("serialize parseCommand", () => {
    const r = ser.parseCommand(".ping hello");
    assert.equal(r.isCommand, true);
    assert.equal(r.command, "ping");
    assert.deepEqual(r.args, ["hello"]);
  });
  check("serialize does not treat #note as prefix", () => {
    const r = ser.parseCommand("#rules");
    assert.equal(r.isCommand, false);
  });
  check("serialize jid helpers", () => {
    assert.equal(ser.getNumber("6281@s.whatsapp.net"), "6281");
    assert.equal(ser.createJid("6281"), "6281@s.whatsapp.net");
  });

  // middleware
  const mw = await import("../lib/middleware.js");
  check("middleware levenshtein", () => {
    assert.equal(mw.levenshtein("ping", "ping"), 0);
    assert.ok(mw.levenshtein("ping", "pong") > 0);
  });
  check("middleware checkPermission", () => {
    const m = { isOwner: false, isPremium: false, isGroup: true, isPrivate: false, isAdmin: false, isBotAdmin: false };
    assert.equal(mw.checkPermission(m, { isOwner: true }).allowed, false);
    assert.equal(mw.checkPermission(m, { isGroup: true }).allowed, true);
    assert.equal(mw.checkPermission(m, { isAdmin: true }).allowed, false);
  });

  // group utils
  const gu = await import("../lib/group-utils.js");
  check("group-utils normalizeToJid", () => {
    assert.equal(gu.normalizeToJid("081234567890"), "6281234567890@s.whatsapp.net");
  });

  // sticker helpers
  const sticker = await import("../lib/sticker.js");
  check("sticker helpers", () => {
    assert.equal(typeof sticker.createStickerFromImage, "function");
    const riff = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(8)]);
    assert.equal(sticker.isWebp(riff), true);
  });

  // plugins loader
  const plugins = await import("../lib/plugins.js");
  await checkAsync("loadPlugins", async () => {
    const count = await plugins.loadPlugins(path.join(process.cwd(), "plugins"));
    assert.ok(count > 0, "no plugins loaded");
  });
  check("expected commands registered", () => {
    const expected = [
      "menu", "help", "allmenu", "addnote", "notes", "delnote",
      "tagall", "hidetag", "tagadmin", "groupinfo", "linkgc", "revoke",
      "setname", "setdesc", "open", "close", "promote", "demote", "kick", "add",
      "sticker", "s", "toimage",
      "tts", "translate", "qr", "calculator", "shorten", "tomp3",
      "search", "ping", "botinfo", "owner", "gempa",
      "mode", "prefix", "ban", "unban", "update", "checkupdate",
    ];
    const missing = expected.filter((c) => !plugins.getPlugin(c));
    assert.equal(missing.length, 0, `missing: ${missing.join(", ")}`);
  });
  check("getCommandsByCategory non-empty", () => {
    const byCat = plugins.getCommandsByCategory();
    assert.ok(Object.keys(byCat).length > 0);
  });

  // case system
  const cases = await import("../case/index.js");
  check("case system", () => {
    assert.ok(cases.getCaseCount() > 0);
    assert.ok(Array.isArray(cases.getCasesByCategory().info));
  });

  // socket extension
  const sockMod = await import("../lib/socket.js");
  check("extendSocket exists", () => {
    assert.equal(typeof sockMod.extendSocket, "function");
  });

  // connection module
  const conn = await import("../core/connection.js");
  check("connection exports", () => {
    for (const fn of ["startConnection", "getSocket", "isConnected", "getUptime", "logout", "isMessageAfterBoot", "waitForConnection"]) {
      assert.equal(typeof conn[fn], "function", `missing ${fn}`);
    }
  });
  check("message gate ignores pre-boot messages", () => {
    const now = 1_000_000_000_000;
    const onlineSince = now - 1000; // socket opened 1s ago
    // A message sent while the bot was offline (5 min ago) must be dropped.
    assert.equal(conn.isMessageAfterBoot(now - 5 * 60 * 1000, onlineSince, now), false);
    // A message that arrived right after the bot came online is processed.
    assert.equal(conn.isMessageAfterBoot(now, onlineSince, now), true);
    // Unknown timestamps are never proven stale.
    assert.equal(conn.isMessageAfterBoot(0, onlineSince, now), true);
    // Before the first open, only the legacy freshness window applies.
    assert.equal(conn.isMessageAfterBoot(now - 60 * 1000, null, now), true);
    assert.equal(conn.isMessageAfterBoot(now - 10 * 60 * 1000, null, now), false);
  });

  // message module
  const msgMod = await import("../core/message.js");
  check("messageHandler exists", () => {
    assert.equal(typeof msgMod.messageHandler, "function");
  });

  // cleanup smoke db
  try {
    fs.rmSync(dbPath, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  // report
  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? "✓" : "✗"} ${r.name}${r.ok ? "" : ` — ${r.error}`}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  try {
    fs.writeFileSync(
      path.join(process.cwd(), "smoke-report.json"),
      JSON.stringify(results, null, 2),
    );
  } catch {
    /* ignore */
  }
  if (failed.length) process.exit(1);
  process.exit(0);
}

main().catch((e) => {
  console.error("smoke test crashed:", e);
  process.exit(1);
});
