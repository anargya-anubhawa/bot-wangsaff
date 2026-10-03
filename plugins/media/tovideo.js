/**
 * GX-ID — /tovideo
 *
 * Converts an ANIMATED sticker (webp) into an MP4 video.
 */
import { getTempDir } from "../../lib/sticker.js";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffmpeg from "fluent-ffmpeg";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const pluginConfig = {
  name: "tovideo",
  alias: ["tomp4", "stickertovideo", "stikertovideo"],
  category: "media",
  description: "Ubah stiker animasi menjadi video MP4",
  usage: ".tovideo (balas stiker animasi)",
  examples: [".tovideo"],
  permission: "all",
  cooldown: 8,
  isEnabled: true,
};

function webpToMp4(buffer) {
  return new Promise((resolve, reject) => {
    const dir = getTempDir();
    const id = crypto.randomBytes(4).toString("hex");
    const input = path.join(dir, `sv_${Date.now()}_${id}.webp`);
    const output = path.join(dir, `sv_${Date.now()}_${id}.mp4`);
    fs.writeFileSync(input, buffer);
    ffmpeg(input)
      .inputOptions(["-y"])
      .outputOptions([
        "-pix_fmt", "yuv420p",
        "-vf", "scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=black",
        "-movflags", "+faststart",
      ])
      .toFormat("mp4")
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
  const target = m.quoted?.isSticker ? m.quoted : m.isSticker ? m : null;
  if (!target) {
    return m.reply(`🎬 *To Video*\n\n> Balas sebuah stiker animasi dengan \`${prefix}tovideo\``);
  }

  await m.react("🕕");
  try {
    const buffer = await target.download();
    if (!buffer) throw new Error("Gagal mengunduh stiker");
    const mp4 = await webpToMp4(buffer);
    await sock.sendMessage(m.chat, { video: mp4, caption: "✅ *Stiker diubah ke video.*", gifPlayback: true }, { quoted: m.raw });
    await m.react("✅");
  } catch (error) {
    await m.react("☢");
    throw error;
  }
}

export { pluginConfig as config, handler };
