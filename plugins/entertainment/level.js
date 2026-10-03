/**
 * GX-ID — /level (all / admin)
 *
 * Unified level/XP command, merging the former `levelstatus`, `setuplevel` and
 * `resetlevel` plugins.
 *
 *   .level [@user]        → show level/XP progress (this group)
 *   .level status [@user] → same as above
 *   .level on | off       → enable/disable the XP system (admin)
 *   .level reset [@user]  → reset XP for the group or one member (admin)
 *
 * Aliases (back-compat): levelstatus/rank/mylevel, setuplevel/levelsetup/
 * aktifkanlevel, resetlevel/resetxp/hapuslevel.
 */
import { resolveTarget, numberFromJid } from "../../lib/group-utils.js";
import { canUseCommand } from "../../lib/access.js";

const pluginConfig = {
  name: "level",
  alias: [
    "levelstatus",
    "rank",
    "mylevel",
    "setuplevel",
    "levelsetup",
    "aktifkanlevel",
    "resetlevel",
    "resetxp",
    "hapuslevel",
  ],
  category: "entertainment",
  description: "Sistem level/XP grup: status, aktif/nonaktif, dan reset",
  usage: ".level [status [@user] | on | off | reset [@user]]",
  examples: [".level", ".level @user", ".level on", ".level reset"],
  parameters: [
    { name: "status", description: "Lihat level (opsional @user)" },
    { name: "on", description: "Aktifkan sistem level di grup ini" },
    { name: "off", description: "Nonaktifkan sistem level di grup ini" },
    { name: "reset", description: "Reset XP (opsional @user)" },
  ],
  helpOnEmpty: true,
  permission: "all",
  isGroup: true,
  cooldown: 3,
  isEnabled: true,
};

const SETUP_ALIASES = new Set(["setuplevel", "levelsetup", "aktifkanlevel"]);
const RESET_ALIASES = new Set(["resetlevel", "resetxp", "hapuslevel"]);

function xpForNextLevel(level) {
  return Math.pow(level, 2) * 100;
}

function parseToggle(arg) {
  const v = String(arg || "").toLowerCase();
  if (["on", "yes", "enable", "aktif", "1", "true"].includes(v)) return true;
  if (["off", "no", "disable", "mati", "0", "false"].includes(v)) return false;
  return null;
}

function adminDenied(m) {
  return m.reply("🔒 *Hanya admin grup* yang boleh mengubah sistem level.");
}

async function handleStatus(m, db) {
  const target = resolveTarget(m) || m.sender;
  const rec = db.getLevel(target, m.chat);
  if (!rec) {
    return m.reply(`📊 @${numberFromJid(target)} belum punya XP di grup ini.`, { mentions: [target] });
  }
  const currentXp = rec.xp || 0;
  const level = rec.level || 1;
  const nextAt = xpForNextLevel(level);
  const prevAt = xpForNextLevel(level - 1);
  const progress = Math.max(0, Math.min(100, Math.floor(((currentXp - prevAt) / (nextAt - prevAt)) * 100)));
  const filled = Math.round(progress / 10);

  await m.reply(
    `🎯 *Level @${numberFromJid(target)}*\n\n` +
      `> Level : *${level}*\n` +
      `> XP    : *${currentXp}* / ${nextAt}\n` +
      `> Pesan : ${rec.messageCount || 0}\n` +
      `> [${"█".repeat(filled)}${"░".repeat(10 - filled)}] ${progress}%`,
    { mentions: [target] },
  );
}

async function handleSetup(m, db, prefix, arg) {
  if (!canUseCommand(m, "admin")) return adminDenied(m);
  const state = parseToggle(arg);
  if (state === null) {
    const current = !!(db.getGroup(m.chat) || {}).levelEnabled;
    return m.reply(`🎯 *Level System*: ${current ? "✅ ON" : "❌ OFF"}\n\n> Usage: \`${prefix}level on|off\``);
  }
  db.setGroup(m.chat, { levelEnabled: state });
  await m.reply(`✅ Sistem level ${state ? "diaktifkan" : "dinonaktifkan"} di grup ini.`);
}

async function handleReset(m, db) {
  if (!canUseCommand(m, "admin")) return adminDenied(m);
  const target = resolveTarget(m);
  if (target) {
    db.resetLevel(target, m.chat);
    return m.reply(`✅ Data level @${numberFromJid(target)} direset.`, { mentions: [target] });
  }
  const count = db.resetLevel(null, m.chat);
  await m.reply(`✅ Data level seluruh grup direset (${count} anggota).`);
}

async function handler(m, ctx) {
  const { db, config } = ctx;
  const prefix = m.prefix || config.command?.prefix || ".";
  const invoked = String(m.command || "level").toLowerCase();
  const args = m.args || [];

  if (SETUP_ALIASES.has(invoked)) return handleSetup(m, db, prefix, args[0]);
  if (RESET_ALIASES.has(invoked)) return handleReset(m, db);
  if (invoked === "levelstatus" || invoked === "rank" || invoked === "mylevel") {
    return handleStatus(m, db);
  }

  /* primary: `.level <sub>` */
  const sub = (args[0] || "").toLowerCase();
  if (sub === "reset") return handleReset(m, db);
  if (sub === "status") return handleStatus(m, db);
  if (parseToggle(sub) !== null) return handleSetup(m, db, prefix, args[0]);
  if (sub === "on" || sub === "off") return handleSetup(m, db, prefix, args[0]);
  return handleStatus(m, db);
}

export { pluginConfig as config, handler };
