/**
 * GX-ID — /schedule (admin target / owner / whitelist)
 *
 * Unified schedule command, merging the former `schedule` (create), `schedules`
 * (list), `unschedule` (delete) and `settimezone` plugins. Every original entry
 * point is preserved as an alias, so existing usages keep working, while the
 * unified interface is parameter driven:
 *
 *   .schedule <HH:MM> daily                    → schedule for THIS group
 *   .schedule <grup> <HH:MM> daily             → target group (alias or id)
 *   .schedule list [grup|global|all]           → list schedules (plain text)
 *   .schedule del [grup|global] <id>           → delete a schedule
 *   .schedule tz <zona>                        → set the IANA timezone
 *
 * Reply to the message you want sent later before creating a schedule.
 * Schedules are persisted, so they survive a restart.
 *
 * Aliases (back-compat): schedules/listschedule/daftarjadwal, unschedule/
 * delschedule/hapusjadwal, settimezone/timezone/setzona/zona.
 */
import { getConfiguredTimezone, isValidTimezone, setConfiguredTimezone, DEFAULT_TIMEZONE } from "../../lib/settings.js";
import { detectMediaType, getMimetype, downloadMedia } from "../../lib/media.js";
import { resolveGroup, resolveManagedTarget } from "../../lib/group-registry.js";
import { GLOBAL_SCOPE, GLOBAL_KEYWORD, isGlobalTarget } from "../../lib/group-scope.js";
import { isOwnerOrWhitelistedIn, canUseCommand } from "../../lib/access.js";

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_RE = /^(\d{2})\.(\d{2})\.(\d{4})$/;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MAX_MEDIA_BYTES = 10 * 1024 * 1024;

const LIST_ALIASES = ["schedules", "listschedule", "daftarjadwal"];
const DEL_ALIASES = ["unschedule", "delschedule", "hapusjadwal"];
const TZ_ALIASES = ["settimezone", "timezone", "setzona", "zona"];

const pluginConfig = {
  name: "schedule",
  alias: [...LIST_ALIASES, ...DEL_ALIASES, ...TZ_ALIASES],
  category: "schedule",
  description: "Kelola jadwal pesan berulang: buat, daftar, hapus, zona waktu",
  usage: ".schedule [list|del|tz] ...  |  .schedule [grup] <HH:MM> <daily|weekly <hari>|once <dd.mm.yyyy>>",
  examples: [".schedule 08:00 daily", ".schedule list", ".schedule del sch_abc123", ".schedule tz Asia/Jakarta"],
  parameters: [
    { name: "list", description: "Tampilkan jadwal" },
    { name: "del", description: "Hapus: del <id>" },
    { name: "tz", description: "Zona waktu: tz <zona>" },
    { name: "grup", description: "Target grup (alias/id)" },
    { name: "<HH:MM>", description: "Jam kirim (mis. 08:00)" },
    { name: "daily|weekly|once", description: "Jenis jadwal berulang" },
  ],
  helpOnEmpty: true,
  permission: "all",
  cooldown: 5,
  isEnabled: true,
};

/* ─────────────────────────── create ─────────────────────────── */

function isRealDate(dd, mm, yyyy) {
  const d = new Date(yyyy, mm - 1, dd);
  return d.getFullYear() === yyyy && d.getMonth() === mm - 1 && d.getDate() === dd;
}

async function handleCreate(m, ctx, rawArgs) {
  const { db, sock, config } = ctx;
  const prefix = m.prefix || config.command?.prefix || ".";
  const args = [...rawArgs];

  /* optional leading target when the first token names a group or `global` */
  let targetArg = null;
  let globalScope = false;
  if (args.length >= 2 && (resolveGroup(args[0]) || isGlobalTarget(args[0]))) {
    targetArg = args.shift();
    globalScope = isGlobalTarget(targetArg);
  }
  const [time, recurrence, recurrenceValue] = args;

  if (!time || !recurrence) {
    return m.reply(
      `⏰ *Jadwalkan Pesan*\n\n` +
        `> Balas pesan yang ingin dikirim, lalu:\n` +
        `> \`${prefix}schedule <HH:MM> daily\` (grup ini)\n` +
        `> \`${prefix}schedule <grup> <HH:MM> daily\`\n` +
        `> \`${prefix}schedule <grup> <HH:MM> weekly <hari>\`\n` +
        `> \`${prefix}schedule <grup> <HH:MM> once <dd.mm.yyyy>\`\n` +
        `> \`${prefix}schedule ${GLOBAL_KEYWORD} <HH:MM> daily\` (semua grup terdaftar)\n\n` +
        `> Zona waktu: *${getConfiguredTimezone()}*`,
    );
  }

  if (!TIME_RE.test(time)) return m.reply("❌ Format waktu tidak valid. Gunakan `HH:MM` (24 jam), mis. `08:30`.");
  const rec = recurrence.toLowerCase();
  if (!["daily", "weekly", "once"].includes(rec)) return m.reply("❌ Recurrence tidak valid: pilih `daily`, `weekly`, atau `once`.");

  let recValue = null;
  if (rec === "weekly") {
    if (!recurrenceValue || !WEEKDAYS.includes(recurrenceValue.toLowerCase())) {
      return m.reply(`❌ Sebutkan hari.\n\n> Contoh: \`${prefix}schedule ${time} weekly monday\``);
    }
    recValue = recurrenceValue.toLowerCase();
  } else if (rec === "once") {
    const match = DATE_RE.exec(recurrenceValue || "");
    if (!match) return m.reply(`❌ Sebutkan tanggal \`dd.mm.yyyy\`.\n\n> Contoh: \`${prefix}schedule ${time} once 25.12.2026\``);
    const [, dd, mm, yyyy] = match;
    if (!isRealDate(Number(dd), Number(mm), Number(yyyy))) return m.reply("❌ Tanggal tidak valid.");
    recValue = `${dd}.${mm}.${yyyy}`;
  }

  const target = globalScope
    ? { jid: GLOBAL_SCOPE, alias: GLOBAL_KEYWORD, registration: null }
    : await resolveManagedTarget(m, ctx, { args: targetArg ? [targetArg] : [] });
  if (target.error) return m.reply(target.error);

  /* global schedules blast every registered group — restrict to the owner */
  if (globalScope && !isOwnerOrWhitelistedIn(m)) {
    return m.reply(`🔒 *Hanya owner* yang boleh membuat jadwal \`${GLOBAL_KEYWORD}\`.`);
  }
  const label = target.alias || target.jid.split("@")[0];

  const quoted = m.quoted;
  const content = quoted?.body || quoted?.text || "";
  const mediaType = quoted ? detectMediaType(quoted) : null;
  if (!content && !mediaType) {
    return m.reply("❌ Balas sebuah pesan (teks/media) yang ingin dikirim nanti.");
  }

  let mediaBase64 = null;
  let mediaMimetype = null;
  if (mediaType) {
    let buffer;
    try {
      buffer = await downloadMedia(quoted, sock);
    } catch {
      return m.reply("❌ Gagal mengunduh media.");
    }
    if (!buffer) return m.reply("❌ Media tidak dapat diunduh.");
    if (buffer.length > MAX_MEDIA_BYTES) return m.reply("❌ Media terlalu besar (maks 10 MB).");
    mediaBase64 = buffer.toString("base64");
    mediaMimetype = getMimetype(quoted) || null;
  }

  const id = `sch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  db.createSchedule(id, {
    jid: target.jid,
    content,
    mediaType,
    mediaBase64,
    mediaMimetype,
    sendTime: time,
    recurrence: rec,
    recurrenceValue: recValue,
    createdBy: m.sender,
  });

  const when = rec === "daily" ? `setiap hari ${time}` : rec === "weekly" ? `setiap ${recValue} ${time}` : `${recValue} ${time}`;
  const scopeNote = globalScope ? " (semua grup terdaftar)" : "";
  await m.reply(
    `✅ *Jadwal dibuat.*\n\n> ID: \`${id}\`\n> Grup: *${label}*${scopeNote}\n> Waktu: ${when}\n> Zona: ${getConfiguredTimezone()}\n\n> Hapus: \`${prefix}schedule del ${id}\``,
  );
}

/* ─────────────────────────── list ─────────────────────────── */

function describe(s) {
  if (s.recurrence === "daily") return `harian ${s.sendTime}`;
  if (s.recurrence === "weekly") return `${s.recurrenceValue} ${s.sendTime}`;
  return `sekali ${s.recurrenceValue} ${s.sendTime}`;
}

function activeSchedules(db) {
  return db.listSchedules().filter((s) => s.active);
}

/** Schedules for a single group, plus the global ones. */
function scopedSchedules(db, jid) {
  const all = activeSchedules(db);
  const globals = all.filter((s) => s.jid === GLOBAL_SCOPE);
  const own = all.filter((s) => s.jid === jid);
  return [...globals, ...own];
}

function scheduleLine(s) {
  const where = s.jid === GLOBAL_SCOPE ? GLOBAL_KEYWORD : String(s.jid).split("@")[0];
  return `┃ \`${s.id}\` ${where} • ${describe(s)}`;
}

async function handleList(m, ctx, arg) {
  const { db } = ctx;
  const prefix = m.prefix || ctx.config?.command?.prefix || ".";
  const lower = String(arg || "").toLowerCase();

  if (lower === "all") {
    if (!m.isOwner) return m.reply("🔒 *Hanya owner* yang boleh melihat jadwal semua grup.");
    const all = activeSchedules(db);
    if (!all.length) return m.reply("⏰ *Belum ada jadwal.*\n\n> Buat dengan `.schedule <grup> <HH:MM> daily`");
    const byGroup = new Map();
    for (const s of all) {
      const key = s.jid;
      if (!byGroup.has(key)) byGroup.set(key, []);
      byGroup.get(key).push(s);
    }
    const sections = [];
    for (const [jid, list] of byGroup) {
      const label = jid === GLOBAL_SCOPE ? `${GLOBAL_KEYWORD.toUpperCase()}` : String(jid).split("@")[0];
      sections.push(`📁 *${label}* (${list.length})\n${list.map(scheduleLine).join("\n")}`);
    }
    return m.reply(`⏰ *Semua Jadwal (${all.length})*\n\n${sections.join("\n\n")}`);
  }

  if (isGlobalTarget(arg)) {
    const globals = activeSchedules(db).filter((s) => s.jid === GLOBAL_SCOPE);
    if (!globals.length) {
      return m.reply(`⏰ *Belum ada jadwal ${GLOBAL_KEYWORD}.*\n\n> Buat: \`${prefix}schedule ${GLOBAL_KEYWORD} <HH:MM> daily\``);
    }
    return m.reply(`⏰ *Jadwal ${GLOBAL_KEYWORD} (${globals.length})*\n\n${globals.map(scheduleLine).join("\n")}`);
  }

  /* single group (alias/id or the current chat); private chat with no arg
     lists everything, preserving the legacy behaviour */
  let jid = m.isGroup ? m.chat : null;
  if (arg) {
    const target = await resolveManagedTarget(m, ctx, { args: [arg] });
    if (target.error) return m.reply(target.error);
    jid = target.jid;
  }
  if (!jid) {
    const all = activeSchedules(db);
    if (!all.length) return m.reply("⏰ *Belum ada jadwal.*\n\n> Buat dengan `.schedule <grup> <HH:MM> daily`");
    return m.reply(`⏰ *Jadwal aktif (${all.length})*\n\n${all.map(scheduleLine).join("\n")}`);
  }

  const scoped = scopedSchedules(db, jid);
  if (!scoped.length) {
    return m.reply("⏰ *Belum ada jadwal.*\n\n> Buat dengan `.schedule <grup> <HH:MM> daily`");
  }
  const reg = db.getRegistration(jid);
  const label = arg ? reg?.alias || String(jid).split("@")[0] : "Jadwal aktif";
  await m.reply(`⏰ *${label} (${scoped.length})*\n\n${scoped.map(scheduleLine).join("\n")}`);
}

/* ─────────────────────────── del ─────────────────────────── */

async function handleDel(m, ctx, args) {
  const prefix = m.prefix || ctx.config?.command?.prefix || ".";

  let targetArg = null;
  let globalScope = false;
  let id = args[0];
  if (args.length >= 2 && (resolveGroup(args[0]) || isGlobalTarget(args[0]))) {
    targetArg = args[0];
    globalScope = isGlobalTarget(args[0]);
    id = args[1];
  }

  if (!id) return m.reply(`⏰ *Hapus Jadwal*\n\n> Usage: \`${prefix}schedule del [grup|${GLOBAL_KEYWORD}] <id>\``);

  if (globalScope && !isOwnerOrWhitelistedIn(m)) {
    return m.reply(`🔒 *Hanya owner* yang boleh menghapus jadwal \`${GLOBAL_KEYWORD}\`.`);
  }

  if (globalScope) {
    const schedule = ctx.db.getSchedule(id);
    if (schedule && schedule.jid !== GLOBAL_SCOPE) {
      return m.reply(`⚠️ Jadwal itu bukan jadwal \`${GLOBAL_KEYWORD}\`.`);
    }
  } else if (targetArg) {
    const target = await resolveManagedTarget(m, ctx, { args: [targetArg] });
    if (target.error) return m.reply(target.error);
    const schedule = ctx.db.getSchedule(id);
    if (schedule && schedule.jid !== target.jid) {
      return m.reply("⚠️ Jadwal itu bukan milik grup tersebut.");
    }
  }

  const removed = ctx.db.deleteSchedule(id);
  if (!removed) return m.reply(`❌ Jadwal \`${id}\` tidak ditemukan.`);
  await m.reply(`🗑️ Jadwal \`${id}\` dihapus.`);
}

/* ─────────────────────────── tz ─────────────────────────── */

async function handleTz(m, ctx, args) {
  const prefix = m.prefix || ctx.config?.command?.prefix || ".";
  if (!canUseCommand(m, "owner")) {
    return m.reply("🔒 *Hanya owner* yang boleh mengubah zona waktu.");
  }
  const zone = (args[0] || "").trim();
  if (!zone) {
    return m.reply(
      `🌏 *Zona Waktu*\n\n> Saat ini: *${getConfiguredTimezone()}* (default ${DEFAULT_TIMEZONE})\n> Usage: \`${prefix}schedule tz <zona IANA>\`\n> Contoh: \`Asia/Jakarta\`, \`Asia/Makassar\`, \`Asia/Jayapura\``,
    );
  }
  if (!isValidTimezone(zone)) {
    return m.reply(`❌ Zona waktu \`${zone}\` tidak valid.\n\n> Gunakan nama IANA, mis. \`Asia/Jakarta\`.`);
  }
  setConfiguredTimezone(zone);
  await m.reply(`✅ Zona waktu diatur ke *${zone}*.`);
}

/* ─────────────────────────── dispatch ─────────────────────────── */

async function handler(m, ctx) {
  const invoked = String(m.command || "schedule").toLowerCase();
  const args = m.args || [];

  if (LIST_ALIASES.includes(invoked)) return handleList(m, ctx, args[0]);
  if (DEL_ALIASES.includes(invoked)) return handleDel(m, ctx, args);
  if (TZ_ALIASES.includes(invoked)) return handleTz(m, ctx, args);

  /* primary: `.schedule <sub>` or `.schedule [grup] <HH:MM> <recurrence>` */
  const sub = (args[0] || "").toLowerCase();
  if (sub === "list") return handleList(m, ctx, args[1]);
  if (sub === "del" || sub === "delete" || sub === "remove" || sub === "hapus") return handleDel(m, ctx, args.slice(1));
  if (sub === "tz" || sub === "timezone" || sub === "zona") return handleTz(m, ctx, args.slice(1));
  if (sub === "add" || sub === "set" || sub === "tambah") return handleCreate(m, ctx, args.slice(1));
  /* bare `.schedule all|global` lists; with more args it is a create target */
  if ((sub === "all" || sub === "global") && args.length === 1) return handleList(m, ctx, args[0]);

  return handleCreate(m, ctx, args);
}

export { pluginConfig as config, handler };
