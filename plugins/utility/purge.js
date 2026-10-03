/**
 * GX-ID — /purge (admin, bot-admin)
 *
 * Deletes the bot's OWN recent messages in this chat. WhatsApp only lets a
 * client revoke messages it authored, so this revokes up to `count` of the ids
 * tracked in `lib/sent-tracker.js` (populated whenever the bot sends a message
 * in this session).
 *
 *   .purge <jumlah>        → delete the last N bot messages
 *   .purge all             → delete every tracked bot message here
 */
import { ensureBotAdmin, BOT_NOT_ADMIN } from "../../lib/plugin-utils.js";
import { getRecentSent, clearSent, sentCount } from "../../lib/sent-tracker.js";
import { logger } from "../../lib/logger.js";

const MAX_PURGE = 50;

const pluginConfig = {
  name: "purge",
  alias: ["bersihkan", "clearchat", "hapuspesanbot"],
  category: "utility",
  description: "Hapus pesan-pesan terakhir dari bot di chat ini",
  usage: ".purge <jumlah|all>",
  examples: [".purge 10", ".purge all"],
  helpOnEmpty: false,
  permission: "admin",
  isGroup: true,
  isBotAdmin: true,
  cooldown: 15,
  notes: "Hanya bisa menghapus pesan yang dikirim bot pada sesi ini.",
  isEnabled: true,
};

async function handler(m, { sock, config }) {
  const prefix = m.prefix || config.command?.prefix || ".";
  const arg = (m.args?.[0] || "").toLowerCase();

  if (!arg) {
    return m.reply(
      `🧹 *Purge*\n\n> Usage: \`${prefix}purge <jumlah>\` (1-${MAX_PURGE}) atau \`${prefix}purge all\`\n> Tercatat: ${sentCount(m.chat)} pesan bot.`,
    );
  }

  if (!(await ensureBotAdmin(m, sock))) return m.reply(BOT_NOT_ADMIN);

  const available = sentCount(m.chat);
  if (!available) {
    return m.reply("ℹ️ Belum ada pesan bot yang tercatat di chat ini untuk dihapus.");
  }

  let count;
  if (arg === "all") {
    count = available;
  } else {
    const n = Number(arg);
    if (!Number.isFinite(n) || n <= 0) {
      return m.reply(`❌ Jumlah tidak valid.\n\n> Contoh: \`${prefix}purge 10\` atau \`${prefix}purge all\``);
    }
    count = Math.min(Math.floor(n), MAX_PURGE, available);
  }

  const toDelete = getRecentSent(m.chat, count).reverse();
  let deleted = 0;
  for (const { id } of toDelete) {
    try {
      await sock.sendMessage(m.chat, { delete: { remoteJid: m.chat, id, fromMe: true } });
      deleted++;
    } catch {
      /* individual failures (already gone / too old) are ignored */
    }
  }

  if (arg === "all" || deleted >= available) clearSent(m.chat);
  logger.warn(`[purge] ${m.sender} deleted ${deleted}/${toDelete.length} bot message(s) in ${m.chat}`);
  await m.reply(`🧹 *Purge selesai.* ${deleted}/${toDelete.length} pesan bot dihapus.`);
}

export { pluginConfig as config, handler };
