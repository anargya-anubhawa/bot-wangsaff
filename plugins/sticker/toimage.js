/**
 * GX-ID — /toimage
 *
 * Convert a sticker into a PNG image.
 */
import { getTempDir } from "../../lib/sticker.js";
import path from "path";
import fs from "fs";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffmpeg from "fluent-ffmpeg";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const pluginConfig = {
  name: "toimage",
  alias: ["toimg", "toimg2", "stickertoimage"],
  category: "sticker",
  description: "Convert a sticker to an image",
  usage: ".toimage (reply to a sticker)",
  example: ".toimage",
  isGroup: false,
  cooldown: 5,
  isEnabled: true,
};

function webpToPng(buffer) {
  return new Promise((resolve, reject) => {
    const dir = getTempDir();
    const input = path.join(dir, `s_${Date.now()}.webp`);
    const output = path.join(dir, `s_${Date.now()}.png`);
    fs.writeFileSync(input, buffer);
    ffmpeg(input)
      .outputOptions(["-vcodec", "png", "-frames:v", "1"])
      .toFormat("png")
      .on("end", () => {
        try {
          const out = fs.readFileSync(output);
          fs.unlinkSync(input);
          fs.unlinkSync(output);
          resolve(out);
        } catch (e) {
          reject(e);
        }
      })
      .on("error", (err) => {
        try {
          if (fs.existsSync(input)) fs.unlinkSync(input);
          if (fs.existsSync(output)) fs.unlinkSync(output);
        } catch {
          /* ignore */
        }
        reject(err);
      })
      .save(output);
  });
}

async function handler(m, { sock, config }) {
  const prefix = m.prefix || config.command?.prefix || ".";
  const target = m.quoted || (m.isSticker ? m : null);

  if (!target?.isSticker) {
    return m.reply(`🖼️ *To Image*\n\n> Reply to a sticker with \`${prefix}toimage\``);
  }

  await m.react("🕕");
  try {
    const buffer = await target.download();
    if (!buffer) throw new Error("Failed to download sticker");
    const png = await webpToPng(buffer);
    await sock.sendMessage(m.chat, { image: png, caption: "✅ *Converted to image.*" }, { quoted: m.raw });
    await m.react("✅");
  } catch (error) {
    await m.react("☢");
    throw error;
  }
}

export { pluginConfig as config, handler };
