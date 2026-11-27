/**
 * VEA — /getdeleted (all)
 *
 * Memulihkan konten pesan yang dihapus (revoke). Balas sebuah pesan (mis. pesan
 * yang membalas pesan terhapus), lalu bot mengirim kembali isi pesan terakhir
 * yang dihapus di chat ini — diambil dari cache recent-messages, jadi hanya
 * berlaku selama masih tersimpan (maks 100 pesan / 100 MB per chat).
 *
 * Media dikirim sebagai dokumen agar kualitasnya utuh.
 */
import { getDeletedFor } from "../../lib/recent-messages.js";

const pluginConfig = {
  name: "getdeleted",
  alias: ["gdl", "undelete", "pulihkan"],
  category: "media",
  description: "Pulihkan konten pesan terakhir yang dihapus di chat ini",
  usage: ".getdeleted (balas pesan apa saja)",
  examples: [".getdeleted"],
  permission: "all",
  cooldown: 5,
  isEnabled: true,
};

const EXT = {
  image: "jpg",
  video: "mp4",
  audio: "mp3",
  sticker: "webp",
  document: "",
};

function documentFor(buffer, mediaType, mimetype, fileName) {
  const ext = EXT[mediaType] || "";
  const name = fileName || `${mediaType || "file"}-${Date.now()}${ext ? `.${ext}` : ""}`;
  return {
    document: buffer,
    fileName: name,
    mimetype: mimetype || "application/octet-stream",
  };
}

async function handler(m, { sock, config }) {
  const prefix = m.prefix || config.command?.prefix || ".";

  const deleted = getDeletedFor(m.chat, m.quoted);
  if (!deleted) {
    return m.reply(
      `Belum ada pesan terhapus yang tersimpan di chat ini.\nBalas sebuah pesan dengan \`${prefix}getdeleted\` setelah ada pesan dihapus.`,
    );
  }

  /* media message — re-send as a document */
  if (deleted.media?.buffer?.length) {
    try {
      await sock.sendMessage(
        m.chat,
        documentFor(deleted.media.buffer, deleted.media.mediaType, deleted.media.mimetype, deleted.media.fileName),
        { quoted: m.raw },
      );
      return;
    } catch (error) {
      await m.reply("Gagal memulihkan media pesan yang dihapus.");
      throw error;
    }
  }

  /* text message — re-send the text */
  if (deleted.body) {
    await sock.sendMessage(m.chat, { text: deleted.body }, { quoted: m.raw });
    return;
  }

  await m.reply("Pesan terakhir yang dihapus tidak punya konten tersimpan.");
}

export { pluginConfig as config, handler };
