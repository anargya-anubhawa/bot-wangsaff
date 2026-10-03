/**
 * GX-ID — /kickall (admin, bot-admin)
 *
 * Removes every non-admin member from the group. This is DESTRUCTIVE and
 * irreversible, so it requires a two-stage confirmation:
 *
 *   1. `.kickall`            → shows a summary + a short-lived token
 *   2. `.kickall confirm <t>` → performs the removal
 *
 * The token is bound to the requesting user AND the group, expires after 60s
 * and cannot be used by anyone else. Cancelling (`.kickall cancel`) or simply
 * letting it expire is always safe.
 */
import { kickAllNonAdmins } from "../../lib/group-service.js";
import { createConfirmation, consumeConfirmation, cancelConfirmation } from "../../lib/confirmation.js";
import { ensureBotAdmin, BOT_NOT_ADMIN } from "../../lib/plugin-utils.js";
import { logger } from "../../lib/logger.js";

const pluginConfig = {
  name: "kickall",
  alias: ["kickmemberall", "tendangsemua"],
  category: "group",
  description: "Keluarkan semua anggota non-admin (butuh konfirmasi 2 tahap)",
  usage: ".kickall  |  .kickall confirm <token>  |  .kickall cancel",
  examples: [".kickall", ".kickall confirm <token>"],
  helpOnEmpty: false,
  permission: "admin",
  isBotAdmin: true,
  // No command-level cooldown: stage 1 and stage 2 must be run back-to-back,
  // and the short-lived confirmation token is itself the rate-limiter.
  cooldown: 0,
  notes: "Konfirmasi berlaku 60 detik dan hanya untuk kamu di grup ini.",
  isEnabled: true,
};

async function handler(m, { sock, config }) {
  const prefix = m.prefix || config.command?.prefix || ".";
  const sub = (m.args?.[0] || "").toLowerCase();

  if (sub === "cancel") {
    cancelConfirmation({ user: m.sender, chat: m.chat, action: "kickall" });
    logger.warn(`[kickall] cancelled by ${m.sender} in ${m.chat}`);
    return m.reply("🛑 *Kickall dibatalkan.*");
  }

  if (sub === "confirm") {
    const token = m.args?.[1];
    if (!token) return m.reply(`❌ Token tidak diberikan. Contoh: \`${prefix}kickall confirm <token>\``);
    const data = consumeConfirmation(token, { user: m.sender, chat: m.chat, action: "kickall" });
    if (!data) {
      logger.warn(`[kickall] invalid/expired token attempt by ${m.sender} in ${m.chat}`);
      return m.reply("❌ *Konfirmasi tidak valid atau sudah kedaluwarsa.* Jalankan `.kickall` lagi.");
    }
    if (!(await ensureBotAdmin(m, sock))) return m.reply(BOT_NOT_ADMIN);

    logger.warn(`[kickall] CONFIRMED by ${m.sender} in ${m.chat} — removing ~${data.count} non-admin(s)`);
    await m.reply(`⏳ *Mengeluarkan ${data.count} anggota non-admin…*`);
    try {
      const count = await kickAllNonAdmins(sock, m.chat);
      logger.warn(`[kickall] done — ${count} member(s) removed from ${m.chat} by ${m.sender}`);
      await m.reply(`✅ *Selesai.* ${count} anggota non-admin telah dikeluarkan.`);
    } catch (error) {
      logger.error(`[kickall] failed in ${m.chat}: ${error.message}`);
      await m.reply("❌ Terjadi kesalahan saat mengeluarkan anggota.");
      throw error;
    }
    return;
  }

  if (sub) {
    return m.reply(`❌ Sub-perintah tidak dikenal.\n\n> Usage: \`${prefix}kickall\` atau \`${prefix}kickall confirm <token>\``);
  }

  if (!(await ensureBotAdmin(m, sock))) return m.reply(BOT_NOT_ADMIN);

  const participants = m.groupMetadata?.participants || [];
  const botNumber = String(sock.user?.id || "").split(":")[0].split("@")[0];
  const targets = participants.filter((p) => {
    if (p.admin) return false;
    const pn = String(p.phoneNumber || p.jid || p.id || "").split(":")[0].split("@")[0];
    return pn && pn !== botNumber;
  });

  if (!targets.length) return m.reply("ℹ️ Tidak ada anggota non-admin untuk dikeluarkan.");

  const token = createConfirmation({
    user: m.sender,
    chat: m.chat,
    action: "kickall",
    data: { count: targets.length },
  });

  logger.info(`[kickall] stage-1 by ${m.sender} in ${m.chat} — ${targets.length} target(s), awaiting confirmation`);

  await m.reply(
    `⚠️ *KONFIRMASI KICKALL*\n\n` +
      `> Target: *${targets.length} anggota non-admin*\n` +
      `> Admin grup tidak akan dikeluarkan.\n\n` +
      `> Konfirmasi: \`${prefix}kickall confirm ${token}\`\n` +
      `> Batal: \`${prefix}kickall cancel\`\n\n` +
      `_Token berlaku 60 detik dan hanya untuk kamu._`,
  );
}

export { pluginConfig as config, handler };
