/**
 * GX-ID — /play
 *
 * Search YouTube for a song name and send the resulting MP3 straight to the
 * chat.
 *
 *   .play <judul lagu>   (alias: .playlagu, .lagu, .song)
 *
 * Uses `src/scraper/ytdl.js` (searchYouTube → resolveAudio → downloadBuffer →
 * fallbackToMp3Buffer), so it shares the same provider chain as `.ytmp3` and
 * needs no hardcoded API keys.
 */
import {
  searchYouTube,
  resolveAudio,
  downloadBuffer,
  fallbackToMp3Buffer,
} from "../../src/scraper/ytdl.js";

const pluginConfig = {
  name: "play",
  alias: ["playlagu", "lagu", "song"],
  category: "download",
  description: "Cari lagu di YouTube lalu kirim file MP3-nya",
  usage: ".play <judul lagu>",
  examples: [".play komang", ".play raim laode"],
  permission: "all",
  cooldown: 15,
  energi: 2,
  isEnabled: true,
};

function formatNumber(num = 0) {
  if (num >= 1e9) return (num / 1e9).toFixed(1) + "B";
  if (num >= 1e6) return (num / 1e6).toFixed(1) + "M";
  if (num >= 1e3) return (num / 1e3).toFixed(1) + "K";
  return String(num);
}

function safeName(title) {
  return String(title || "lagu").replace(/[\\/:*?"<>|\n\r]+/g, "_").slice(0, 80);
}

async function handler(m, { sock }) {
  const query = (m.text || "").trim();
  if (!query) {
    return m.reply(`🎵 *PLAY LAGU*\n\n> Contoh: \`${m.prefix}${m.command} komang\``);
  }

  await m.react("🔍");

  try {
    const [video] = await searchYouTube(query, 1);
    if (!video?.url) throw new Error("Lagu tidak ditemukan.");

    await m.react("🕕");

    const info = await resolveAudio(video.url);
    if (!info?.url) throw new Error("Gagal mendapatkan audio.");

    const raw = await downloadBuffer(info.url);
    const mp3 = await fallbackToMp3Buffer(raw);

    const title = info.title || video.title;
    const caption =
      `🎵 *NOW PLAYING*\n\n` +
      `📌 *Judul:* ${title}\n` +
      `👤 *Channel:* ${video.author || "-"}\n` +
      `⏱️ *Durasi:* ${video.timestamp || "-"}\n` +
      `👀 *Views:* ${formatNumber(video.views)}\n\n` +
      `🔗 ${video.url}`;

    if (video.thumbnail) {
      await sock
        .sendMessage(m.chat, { image: { url: video.thumbnail }, caption }, { quoted: m.raw })
        .catch(() => {});
    }

    await sock.sendMessage(
      m.chat,
      {
        audio: mp3,
        mimetype: "audio/mpeg",
        ptt: false,
        fileName: `${safeName(title)}.mp3`,
      },
      { quoted: m.raw },
    );

    await m.react("✅");
  } catch (error) {
    await m.react("❌");
    return m.reply(`❌ *Gagal memutar lagu.*\n\n> ${error.message}`);
  }
}

export { pluginConfig as config, handler };
