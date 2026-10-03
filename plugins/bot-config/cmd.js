/**
 * GX-ID — /cmd (owner / admin)
 *
 * One command to rule the runtime command-control features that used to live in
 * four separate files (`commandcd`, `cmdaccess`, `disablecmd`, `enablecmd`).
 * Every original entry point is preserved as an alias, so existing usages keep
 * working, while the unified interface is parameter driven:
 *
 *   .cmd cd <Ns|Nm|Nh>                  → per-group command cooldown (admin)
 *   .cmd access <command> <all|admin|owner|reset>
 *   .cmd access list                    → list runtime access overrides
 *   .cmd disable <nama> [global|grup|pc]
 *   .cmd enable  <nama> [global|grup|pc]
 *   .cmd list                           → show the current control state
 *
 * `<nama>` may be a command name, a category or a feature — the middleware
 * matches the plugin's name, category and aliases. Scopes:
 *   global → everywhere (default)
 *   grup   → only inside the current group
 *   pc     → only in private chat
 *
 * Aliases (back-compat): commandcd/cmdcd/cooldown/jedacommand, cmdaccess/
 * accesscmd/setaccess, disablecmd/disable/matikancommand, enablecmd/enable/
 * nyalakancommand.
 */
import { setGroupCooldown, getGroupCooldown } from "../../lib/cooldown.js";
import { canUseCommand } from "../../lib/access.js";

const LEGACY = {
  commandcd: "cd",
  cmdcd: "cd",
  cooldown: "cd",
  jedacommand: "cd",
  cmdaccess: "access",
  accesscmd: "access",
  setaccess: "access",
  disablecmd: "disable",
  disable: "disable",
  matikancommand: "disable",
  enablecmd: "enable",
  enable: "enable",
  nyalakancommand: "enable",
};

const pluginConfig = {
  name: "cmd",
  alias: [
    "commandcd",
    "cmdcd",
    "cooldown",
    "jedacommand",
    "cmdaccess",
    "accesscmd",
    "setaccess",
    "disablecmd",
    "disable",
    "matikancommand",
    "enablecmd",
    "enable",
    "nyalakancommand",
  ],
  category: "bot-config",
  description: "Kelola perintah: cooldown, override akses, aktif/nonaktif",
  usage: ".cmd <cd|access|enable|disable|list> ...",
  examples: [".cmd cd 10s", ".cmd access sticker admin", ".cmd disable sticker global", ".cmd list"],
  parameters: [
    { name: "cd", description: "Jeda perintah per-grup: cd <Ns|Nm|Nh>" },
    { name: "access", description: "Override akses: access <cmd> <all|admin|owner|reset>" },
    { name: "disable", description: "Nonaktifkan: disable <nama> [global|grup|pc]" },
    { name: "enable", description: "Aktifkan: enable <nama> [global|grup|pc]" },
    { name: "list", description: "Lihat status kontrol perintah" },
  ],
  helpOnEmpty: true,
  permission: "all",
  cooldown: 3,
  isEnabled: true,
};

const TIERS = new Set(["all", "admin", "owner"]);
const SCOPE_GROUP = new Set(["grup", "group", "gc"]);
const SCOPE_PC = new Set(["pc", "private", "pm", "pribadi", "dm"]);

function parseDuration(arg) {
  const match = /^(\d+)([smh])$/i.exec(String(arg || ""));
  if (!match) return null;
  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  if (unit === "s") return value > 60 ? null : value;
  if (unit === "m") return value > 60 ? null : value * 60;
  return value > 24 ? null : value * 3600;
}

function format(seconds) {
  if (seconds === 0) return "nonaktif";
  if (seconds % 3600 === 0 && seconds >= 3600) return `${seconds / 3600}h`;
  if (seconds % 60 === 0 && seconds >= 60) return `${seconds / 60}m`;
  return `${seconds}s`;
}

function normalizeScope(value) {
  const scope = String(value || "").toLowerCase();
  if (SCOPE_GROUP.has(scope)) return "group";
  if (SCOPE_PC.has(scope)) return "pc";
  return "global";
}

function cleanName(value) {
  return String(value || "").toLowerCase().replace(/^[./]/, "");
}

function help(prefix) {
  return (
    `🎛️ *Command Control*\n\n` +
    `> \`${prefix}cmd cd <Ns|Nm|Nh>\` — jeda perintah per-grup\n` +
    `> \`${prefix}cmd access <cmd> <all|admin|owner|reset>\`\n` +
    `> \`${prefix}cmd disable <nama> [global|grup|pc]\`\n` +
    `> \`${prefix}cmd enable <nama> [global|grup|pc]\`\n` +
    `> \`${prefix}cmd list\` — lihat status\n\n` +
    `> \`<nama>\` bisa nama perintah, kategori, atau fitur.`
  );
}

/* ─────────────────────────── cd ─────────────────────────── */

async function handleCd(m, prefix, args) {
  if (!m.isGroup) return m.reply("❌ Perintah ini hanya bisa dipakai di dalam grup.");
  if (!canUseCommand(m, "admin")) {
    return m.reply("🔒 *Hanya admin grup* yang boleh mengatur cooldown perintah.");
  }
  const arg = args[0];
  if (!arg) {
    const current = getGroupCooldown(m.chat);
    return m.reply(`⏱️ *Command Cooldown*: ${format(current)}\n\n> Usage: \`${prefix}cmd cd <Ns|Nm|Nh>\``);
  }
  const seconds = parseDuration(arg);
  if (seconds === null) {
    return m.reply(`❌ Format tidak valid.\n\n> Contoh: \`${prefix}cmd cd 10s\`, \`${prefix}cmd cd 1m\`, \`${prefix}cmd cd 1h\``);
  }
  setGroupCooldown(m.chat, seconds);
  await m.reply(`✅ Jeda perintah diatur ke *${format(seconds)}*.`);
}

/* ─────────────────────────── access ─────────────────────────── */

async function handleAccess(m, db, prefix, args) {
  if (!canUseCommand(m, "owner")) {
    return m.reply("🔒 *Hanya owner* yang boleh mengubah tingkat izin perintah.");
  }
  const name = cleanName(args[0]);
  const value = (args[1] || "").toLowerCase();

  if (!name || name === "list") {
    const overrides = db.setting("commandAccess") || {};
    const entries = Object.entries(overrides);
    if (!entries.length) {
      return m.reply(`🔐 *Command Access*\n\n> Belum ada override.\n> Usage: \`${prefix}cmd access <command> <all|admin|owner>\``);
    }
    const lines = entries.map(([cmd, tier]) => `┃ \`${cmd}\` → *${tier}*`);
    return m.reply(`🔐 *Override akses (${entries.length})*\n\n${lines.join("\n")}`);
  }

  const overrides = { ...(db.setting("commandAccess") || {}) };

  if (value === "reset" || value === "default") {
    if (!overrides[name]) return m.reply(`⚠️ \`${name}\` tidak punya override.`);
    delete overrides[name];
    db.setting("commandAccess", overrides);
    return m.reply(`✅ Override \`${name}\` dihapus (kembali ke default plugin).`);
  }

  if (!TIERS.has(value)) {
    return m.reply(`❌ Tingkat tidak valid.\n\n> Pilih: \`all\`, \`admin\`, \`owner\`, atau \`reset\``);
  }

  overrides[name] = value;
  db.setting("commandAccess", overrides);
  await m.reply(`✅ \`${name}\` sekarang memerlukan tingkat: *${value}*.`);
}

/* ─────────────────────────── enable / disable ─────────────────────────── */

function applyToggle(m, db, scope, name, enable) {
  if (scope === "group") {
    const group = db.getGroup(m.chat) || {};
    const list = new Set(group.disabledCommands || []);
    if (enable) {
      if (!list.has(name)) return `⚠️ \`${name}\` memang tidak dinonaktifkan di grup ini.`;
      list.delete(name);
      db.setGroup(m.chat, { disabledCommands: [...list] });
      return `✅ \`${name}\` diaktifkan kembali di grup ini.`;
    }
    if (list.has(name)) return `⚠️ \`${name}\` sudah dinonaktifkan di grup ini.`;
    list.add(name);
    db.setGroup(m.chat, { disabledCommands: [...list] });
    return `✅ \`${name}\` dinonaktifkan di grup ini.`;
  }

  const key = scope === "pc" ? "disabledPrivateCommands" : "disabledCommands";
  const list = new Set(db.setting(key) || []);
  const where = scope === "pc" ? "di private chat" : "secara global";
  if (enable) {
    if (!list.has(name)) return `⚠️ \`${name}\` memang tidak dinonaktifkan ${where}.`;
    list.delete(name);
    db.setting(key, [...list]);
    return `✅ \`${name}\` diaktifkan kembali ${where}.`;
  }
  if (list.has(name)) return `⚠️ \`${name}\` sudah dinonaktifkan ${where}.`;
  list.add(name);
  db.setting(key, [...list]);
  return `✅ \`${name}\` dinonaktifkan ${where}.`;
}

async function handleToggle(m, db, prefix, args, enable) {
  if (!canUseCommand(m, "owner")) {
    return m.reply(`🔒 *Hanya owner* yang boleh ${enable ? "mengaktifkan" : "menonaktifkan"} perintah.`);
  }
  const name = cleanName(args[0]);
  if (!name) {
    return m.reply(`🚫 *${enable ? "Enable" : "Disable"} Command*\n\n> Usage: \`${prefix}cmd ${enable ? "enable" : "disable"} <nama> [global|grup|pc]\``);
  }
  const scope = normalizeScope(args[1]);
  if (scope === "group" && !m.isGroup) {
    return m.reply("❌ Scope `grup` hanya bisa dipakai di dalam grup.");
  }
  return m.reply(applyToggle(m, db, scope, name, enable));
}

/* ─────────────────────────── list ─────────────────────────── */

async function handleList(m, db, prefix) {
  if (!canUseCommand(m, "owner")) {
    return m.reply("🔒 *Hanya owner* yang boleh melihat status kontrol perintah.");
  }
  const global = db.setting("disabledCommands") || [];
  const pc = db.setting("disabledPrivateCommands") || [];
  const group = m.isGroup ? (db.getGroup(m.chat) || {}).disabledCommands || [] : [];
  const overrides = Object.entries(db.setting("commandAccess") || {});
  const lines = [
    `> 🌐 Global: ${global.length ? global.map((n) => `\`${n}\``).join(", ") : "—"}`,
    `> 💬 PC: ${pc.length ? pc.map((n) => `\`${n}\``).join(", ") : "—"}`,
  ];
  if (m.isGroup) lines.push(`> 📁 Grup: ${group.length ? group.map((n) => `\`${n}\``).join(", ") : "—"}`);
  if (overrides.length) lines.push(`> 🔐 Akses: ${overrides.map(([c, t]) => `\`${c}\`→*${t}*`).join(", ")}`);
  return m.reply(`🎛️ *Command Control*\n\n${lines.join("\n")}\n\n> Usage: \`${prefix}cmd <cd|access|enable|disable|list>\``);
}

/* ─────────────────────────── dispatch ─────────────────────────── */

async function handler(m, ctx) {
  const { db, config } = ctx;
  const prefix = m.prefix || config.command?.prefix || ".";
  const invoked = String(m.command || "cmd").toLowerCase();
  const rawArgs = m.args || [];

  let sub = LEGACY[invoked];
  let rest = rawArgs;
  if (!sub) {
    sub = (rawArgs[0] || "").toLowerCase();
    rest = rawArgs.slice(1);
  }

  switch (sub) {
    case "cd":
      return handleCd(m, prefix, rest);
    case "access":
      return handleAccess(m, db, prefix, rest);
    case "disable":
      return handleToggle(m, db, prefix, rest, false);
    case "enable":
      return handleToggle(m, db, prefix, rest, true);
    case "list":
      return handleList(m, db, prefix);
    default:
      return m.reply(help(prefix));
  }
}

export { pluginConfig as config, handler };
