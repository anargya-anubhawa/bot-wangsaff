/**
 * GX-ID — /reload (owner only)
 *
 * Re-imports and re-registers every plugin from disk without restarting the
 * process. The WhatsApp connection, database and scheduler keep running, so a
 * plugin edit goes live instantly with zero downtime.
 *
 * Usage:
 *   .reload            → reload all plugins
 *   .reload status     → show the current registry size (no reload)
 */
import path from "path";
import { loadPlugins, getPluginCount, getConflicts } from "../../lib/plugins.js";

const pluginConfig = {
  name: "reload",
  alias: ["reloadplugin", "reloadplugins", "hotreload"],
  category: "owner",
  description: "Muat ulang semua plugin tanpa restart bot",
  usage: ".reload [status]",
  examples: [".reload", ".reload status"],
  parameters: [{ name: "status", description: "Tampilkan jumlah plugin tanpa memuat ulang" }],
  helpOnEmpty: false,
  permission: "owner",
  cooldown: 3,
  isEnabled: true,
};

async function handler(m, { config }) {
  const prefix = m.prefix || config.command?.prefix || ".";
  const sub = (m.args[0] || "").toLowerCase();

  if (sub === "status") {
    return m.reply(
      `⚙️ *Plugin Registry*\n\n> Terdaftar : *${getPluginCount()}* plugin\n> Konflik   : *${getConflicts().length}*`,
    );
  }

  const started = Date.now();
  const count = await loadPlugins(path.join(process.cwd(), "plugins"), { bustCache: true });
  const elapsed = Date.now() - started;
  const conflicts = getConflicts();

  const lines = [
    `♻️ *Plugin dimuat ulang*`,
    ``,
    `> Plugin   : *${count}*`,
    `> Konflik  : *${conflicts.length}*`,
    `> Durasi   : *${elapsed} ms*`,
  ];
  if (conflicts.length) {
    lines.push(``, `⚠️ *Duplikat (${conflicts.length}):*`);
    for (const c of conflicts.slice(0, 5)) {
      lines.push(`> ${c.kind} \`${c.name}\` — dipakai *${c.kept}*, diabaikan *${c.dropped}*`);
    }
    if (conflicts.length > 5) lines.push(`> … +${conflicts.length - 5} lainnya`);
  }
  lines.push(``, `> Perubahan \`.env\` / config tetap butuh \`${prefix}restart\`.`);

  await m.reply(lines.join("\n"));
}

export { pluginConfig as config, handler };
