/**
 * GX-ID — /botinfo
 *
 * Unified bot information card — merges the former `.sysinfo` and `.runtime`
 * commands. Reports bot identity, connection, runtime/system diagnostics and
 * database counts WITHOUT ever exposing secrets: no tokens, no session paths,
 * no database paths, no environment values.
 *
 *   .botinfo          → full info card
 *   .botinfo system   → system-focused view (same data, section first)
 */
import os from "os";
import { getPluginCount, getCategories } from "../../lib/plugins.js";
import { getSocket } from "../../core/connection.js";
import { formatFull } from "../../lib/time.js";
import { humanBytes, humanUptime, getRuntimeInfo, getDiskInfo, getMemoryInfo, getLoadAvg } from "../../lib/system-info.js";

const pluginConfig = {
  name: "botinfo",
  alias: ["info", "about", "bot", "sysinfo", "system", "serverinfo", "runtime"],
  category: "info",
  description: "Informasi bot, runtime & sistem (tanpa data sensitif)",
  usage: ".botinfo",
  examples: [".botinfo"],
  permission: "all",
  cooldown: 5,
  isEnabled: true,
};

async function handler(m, { db, uptime, config }) {
  const prefix = m.prefix || config.command?.prefix || ".";
  const rt = getRuntimeInfo();
  const mem = process.memoryUsage();
  const sysMem = getMemoryInfo();
  const load = getLoadAvg();
  const disk = getDiskInfo();

  const totalUsers = db.getUserCount();
  const totalGroups = Object.keys(db.getAllGroups?.() || {}).length;

  const text =
    `🤖 *${config.bot?.name || "GX-ID"}*\n\n` +
    `╭┈┈⬡「 ℹ️ *info* 」\n` +
    `┃ ◦ Name      : *${config.bot?.name || "GX-ID"}*\n` +
    `┃ ◦ Version   : *${config.bot?.version || "1.0.0"}*\n` +
    `┃ ◦ Developer : *${config.bot?.developer || "GX-ID Developer"}*\n` +
    `┃ ◦ Owner     : *${config.owner?.name || "GeneticID"}*\n` +
    `┃ ◦ Library   : \`@whiskeysockets/baileys\`\n` +
    `┃ ◦ Mode      : *${(config.mode || "public").toUpperCase()}*\n` +
    `┃ ◦ Prefix    : \`${config.command?.prefix || "."}\`\n` +
    `┃ ◦ Socket    : *${getSocket() ? "terhubung" : "terputus"}*\n` +
    `╰┈┈⬡\n\n` +
    `╭┈┈⬡「 📊 *stats* 」\n` +
    `┃ ◦ Uptime    : *${humanUptime((uptime || 0) / 1000)}*\n` +
    `┃ ◦ Plugins   : *${getPluginCount()}* (${getCategories().length} kategori)\n` +
    `┃ ◦ Users     : *${totalUsers}*\n` +
    `┃ ◦ Groups    : *${totalGroups}*\n` +
    `┃ ◦ Time      : ${formatFull("dddd, DD MMMM YYYY HH:mm:ss")}\n` +
    `╰┈┈⬡\n\n` +
    `╭┈┈⬡「 ⚙️ *runtime* 」\n` +
    `┃ ◦ Node.js   : *${rt.node}*\n` +
    `┃ ◦ V8        : *${rt.v8}*\n` +
    `┃ ◦ Platform  : *${os.platform()} ${os.arch()}*\n` +
    `┃ ◦ CPU       : *${os.cpus()?.length || 0} core*\n` +
    `┃ ◦ Load avg  : *${load.one.toFixed(2)} / ${load.five.toFixed(2)} / ${load.fifteen.toFixed(2)}*\n` +
    `┃ ◦ RAM proc  : *${humanBytes(mem.rss)}*\n` +
    `┃ ◦ RAM sys   : *${humanBytes(sysMem.used)} / ${humanBytes(sysMem.total)}*\n` +
    `┃ ◦ Disk      : *${disk ? `${humanBytes(disk.used)} / ${humanBytes(disk.total)}` : "—"}*\n` +
    `┃ ◦ Bot up    : *${humanUptime(rt.processUptime)}*\n` +
    `┃ ◦ Sys up    : *${humanUptime(rt.systemUptime)}*\n` +
    `╰┈┈⬡\n\n` +
    `> Server detail: \`${prefix}vpsinfo\`\n` +
    `> Menu: \`${prefix}menu\``;

  await m.reply(text);
}

export { pluginConfig as config, handler };
