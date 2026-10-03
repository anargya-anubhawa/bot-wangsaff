/**
 * GX-ID — /top
 *
 * Shows the group's level leaderboard.
 */
const pluginConfig = {
  name: "top",
  alias: ["leaderboard", "toplvl", "peringkat"],
  category: "entertainment",
  description: "Tampilkan peringkat level di grup ini",
  usage: ".top [jumlah]",
  examples: [".top", ".top 20"],
  permission: "all",
  isGroup: true,
  cooldown: 5,
  isEnabled: true,
};

const MEDALS = ["🥇", "🥈", "🥉"];

async function handler(m, { db, config }) {
  const prefix = m.prefix || config.command?.prefix || ".";
  const limit = Math.min(Math.max(Number(m.args?.[0]) || 10, 1), 25);
  const rows = db.getTopLevels(m.chat, limit);

  if (!rows.length) {
    return m.reply(`🏆 *Belum ada data level.*\n\n> Aktifkan dengan \`${prefix}setuplevel on\``);
  }

  const lines = rows.map((r, i) => {
    const medal = MEDALS[i] || `${i + 1}.`;
    return `┃ ${medal} @${r.jid} — Lv ${r.level} (${r.xp} XP)`;
  });

  await m.reply(`🏆 *Peringkat Level (${rows.length})*\n\n╭─〔 top 〕\n${lines.join("\n")}\n╰─⬣`);
}

export { pluginConfig as config, handler };
