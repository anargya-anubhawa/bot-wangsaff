/**
 * GX-ID — /stats (all)
 *
 * Shows how often each command has been used, GLOBALLY, since the bot started
 * counting. Counters live in the bot's existing `stats.json` under
 * `stats.commands` (`{ "<command>": <count> }`) and are bumped on every
 * successful dispatch (plugin or case command). Aliases are folded into the
 * command's primary name, so `.reboot` counts towards `.restart`.
 *
 * Usage:
 *   .stats            → top 10 most-used commands
 *   .stats all        → every command, ranked
 *   .stats reset      → wipe the counters (owner only)
 *   .stats help       → usage card
 */
import { renderCommandUsage } from "../../lib/command-usage.js";

const DEFAULT_LIMIT = 10;

const pluginConfig = {
  name: "stats",
  alias: ["statistik", "topcmd", "commandstats", "cmdstats"],
  category: "info",
  description: "Statistik command yang dipakai secara global (paling sering dipakai)",
  usage: ".stats [all|reset|help]",
  examples: [".stats", ".stats all", ".stats reset"],
  parameters: [
    { name: "all", description: "Tampilkan semua command (bukan hanya 10 teratas)" },
    { name: "reset", description: "Hapus semua statistik command (khusus owner)" },
    { name: "help", description: "Tampilkan kartu usage" },
  ],
  helpOnEmpty: false,
  permission: "all",
  cooldown: 5,
  isEnabled: true,
};

/** `12345` → `12.345` (Indonesian thousands separator). */
function formatNumber(value) {
  return (Number(value) || 0).toLocaleString("id-ID");
}

function renderStats(rows, { limit, total, unique }) {
  const shown = rows.length;
  const L = [];
  L.push(`📊 *STATISTIK COMMAND*`);
  L.push(``);
  L.push(`╭─〔 📈 *RINGKASAN* 〕`);
  L.push(`┃ ◦ Total dipakai  : *${formatNumber(total)}* kali`);
  L.push(`┃ ◦ Command unik   : *${formatNumber(unique)}*`);
  L.push(`┃ ◦ Ditampilkan    : *${limit > 0 ? shown : "semua"}*${limit > 0 ? " teratas" : ""}`);
  L.push(`╰─⬣`);
  L.push(``);
  L.push(`╭─〔 🏆 *TOP COMMAND* 〕`);
  rows.forEach((entry, index) => {
    L.push(`┃ ${String(index + 1).padStart(2)}. \`.${entry.name}\` — *${formatNumber(entry.count)}* kali`);
  });
  L.push(`╰─⬣`);
  return L.join("\n");
}

async function handler(m, { db, config }) {
  const prefix = m.prefix || config.command?.prefix || ".";
  const sub = (m.args[0] || "").toLowerCase();

  if (sub === "help" || sub === "bantuan" || sub === "usage") {
    return m.reply(renderCommandUsage(pluginConfig, prefix));
  }

  if (sub === "reset" || sub === "clear" || sub === "hapus") {
    if (!m.isOwner) {
      return m.reply("🔒 *Hanya owner* yang boleh mereset statistik command.");
    }
    const removed = db.resetCommandStats();
    return m.reply(
      `🧹 *Statistik command direset.*\n\n> ${removed} command dihapus dari hitungan.`,
    );
  }

  const showAll = sub === "all" || sub === "semua";
  const limit = showAll ? 0 : DEFAULT_LIMIT;
  const unique = db.getCommandStatCount();
  const total = db.getTotalCommandUsage();

  if (!unique) {
    return m.reply(
      `📊 *STATISTIK COMMAND*\n\n> Belum ada data — belum ada command yang dipakai sejak pencatatan dimulai.`,
    );
  }

  const rows = db.getTopCommands(limit || 0);
  let text = renderStats(rows, { limit, total, unique });

  if (showAll) {
    text += `\n\n> Ringkasan saja: \`${prefix}stats\``;
  } else {
    text += `\n\n> Tampilkan semua (*${unique}*): \`${prefix}stats all\``;
  }

  /* A very large registry could push the "all" view past WhatsApp's message
     limit — split on line boundaries so nothing is ever truncated. */
  const MAX = 60000;
  if (text.length > MAX) {
    const lines = text.split("\n");
    let chunk = "";
    for (const line of lines) {
      if (chunk && chunk.length + line.length + 1 > MAX) {
        await m.reply(chunk);
        chunk = "";
      }
      chunk += (chunk ? "\n" : "") + line;
    }
    if (chunk) await m.reply(chunk);
    return;
  }

  await m.reply(text);
}

export { pluginConfig as config, handler };
