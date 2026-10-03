/**
 * GX-ID — /tomp3
 *
 * Extract audio from a video / voice note and send it as an MP3 document or
 * audio message. Uses the bundled ffmpeg.
 */
import fs from "fs";
import path from "path";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffmpeg from "fluent-ffmpeg";
import { getTempDir } from "../../lib/sticker.js";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const pluginConfig = {
  name: "tomp3",
  alias: ["toaudio", "tomp3audio", "extractaudio"],
  category: "media",
  description: "Extract audio from a video/voice note",
  usage: ".tomp3 (reply to a video/audio)",
  example: ".tomp3",
  isOwner: false,
  isGroup: false,
  cooldown: 10,
  isEnabled: true,
};

function toMp3(buffer, ext) {
  return new Promise((resolve, reject) => {
    const dir = getTempDir();
    const input = path.join(dir, `a_${Date.now()}.${ext}`);
    const output = path.join(dir, `a_${Date.now()}.mp3`);
    fs.writeFileSync(input, buffer);
    ffmpeg(input)
      .outputOptions(["-vn", "-ab", "128k", "-ar", "44100", "-f", "mp3"])
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
  const target = m.quoted || (m.isVideo || m.isAudio ? m : null);
  if (!target || !(target.isVideo || target.isAudio)) {
    return m.reply(`🎵 *To MP3*\n\n> Reply to a video or audio with \`${prefix}tomp3\``);
  }

  await m.react("🕕");
  try {
    const buffer = await target.download();
    if (!buffer) throw new Error("Failed to download media");
    const ext = target.isVideo ? "mp4" : "ogg";
    const mp3 = await toMp3(buffer, ext);
    await sock.sendMessage(
      m.chat,
      { audio: mp3, mimetype: "audio/mpeg", ptt: false },
      { quoted: m.raw },
    );
    await m.react("✅");
  } catch (error) {
    await m.react("☢");
    throw error;
  }
}

export { pluginConfig as config, handler };
