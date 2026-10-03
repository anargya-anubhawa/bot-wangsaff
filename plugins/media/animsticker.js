/**
 * GX-ID — /animsticker (alias /animstiker)
 *
 * Converts a short video/GIF into an ANIMATED sticker, honouring the global
 * `animstickeroptions` (duration/fps/emojis).
 */
import { createStickerFromVideo } from "../../lib/sticker.js";
import { getAnimStickerOptions } from "../../lib/settings.js";

const pluginConfig = {
  name: "animsticker",
  alias: ["animstiker", "animatedsticker", "stikeranimasi"],
  category: "media",
  description: "Ubah video/GIF menjadi stiker animasi",
  usage: ".animsticker (balas video/GIF)",
  examples: [".animsticker"],
  permission: "all",
  cooldown: 8,
  isEnabled: true,
};

function parseOptions(raw) {
  const options = { duration: 6, fps: 15, emojis: [] };
  if (!raw) return options;
  for (const token of String(raw).split(",")) {
    const [key, value] = token.split("=").map((s) => s.trim());
    if (key === "duration" && Number(value) > 0) options.duration = Math.min(Number(value), 15);
    else if (key === "fps" && Number(value) > 0) options.fps = Math.min(Number(value), 30);
    else if (key === "emojis") options.emojis = value.split(" ").filter(Boolean);
  }
  return options;
}

async function handler(m, { sock, config }) {
  const prefix = m.prefix || config.command?.prefix || ".";
  const media = m.isVideo ? m : m.quoted?.isVideo ? m.quoted : null;
  if (!media) {
    return m.reply(`🎞️ *Anim Sticker*\n\n> Balas sebuah video/GIF dengan \`${prefix}animsticker\``);
  }

  const stored = parseOptions(getAnimStickerOptions());
  const packname = m.args?.[0] || config.sticker?.packname || "GX-ID";
  const author = m.args?.[1] || config.sticker?.author || "GX-ID";

  await m.react("🕕");
  try {
    const buffer = await media.download();
    if (!buffer) throw new Error("Gagal mengunduh media");
    const webp = await createStickerFromVideo(buffer, {
      packname,
      author,
      duration: stored.duration,
      fps: stored.fps,
      emojis: stored.emojis,
    });
    await sock.sendMessage(m.chat, { sticker: webp }, { quoted: m.raw });
    await m.react("✅");
  } catch (error) {
    await m.react("☢");
    throw error;
  }
}

export { pluginConfig as config, handler };
