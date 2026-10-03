/**
 * GX-ID — /getvo (all)
 *
 * Re-sends the most recent view-once media seen in this chat (or the media the
 * sender of the replied view-once message sent). Requires the pipeline to have
 * cached it when it arrived — view-once media cannot be fetched after the fact.
 */
import { getCachedViewOnce, listCachedViewOnce } from "../../lib/view-once.js";
import { numberFromJid } from "../../lib/group-utils.js";

const pluginConfig = {
  name: "getvo",
  alias: ["viewonce", "readvo", "bukaviewonce"],
  category: "media",
  description: "Ambil ulang media view-once terakhir di chat ini",
  usage: ".getvo [@user]",
  examples: [".getvo"],
  permission: "all",
  cooldown: 5,
  isEnabled: true,
};

async function handler(m, { sock, config }) {
  const prefix = m.prefix || config.command?.prefix || ".";
  const all = listCachedViewOnce(m.chat);
  if (!all.length) {
    return m.reply(
      `👁️ *View Once*\n\n> Belum ada media view-once yang tersimpan di chat ini.\n> Cache berlaku selama 1 jam sejak media diterima.`,
    );
  }

  const sender = m.mentionedJid?.[0] || (m.quoted?.sender || null);
  const entry = getCachedViewOnce(m.chat, sender);
  if (!entry) return m.reply(`❓ Tidak ada media view-once dari pengirim itu.`);

  try {
    const buffer = await entry.download();
    if (!buffer) throw new Error("empty");

    let content;
    const caption = `👁️ *View Once* (dari @${numberFromJid(entry.sender)})`;
    switch (entry.mediaType) {
      case "imageMessage":
        content = { image: buffer, caption };
        break;
      case "videoMessage":
        content = { video: buffer, caption };
        break;
      case "audioMessage":
        content = { audio: buffer, mimetype: "audio/mp4" };
        break;
      default:
        content = { document: buffer, mimetype: "application/octet-stream", fileName: "viewonce", caption };
    }
    await sock.sendMessage(m.chat, content, { quoted: m.raw });
  } catch (error) {
    await m.reply("❌ Gagal mengambil media view-once (mungkin sudah kedaluwarsa).");
    throw error;
  }
}

export { pluginConfig as config, handler };
