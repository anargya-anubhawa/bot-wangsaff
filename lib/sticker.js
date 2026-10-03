/**
 * GX-ID — sticker / media conversion helpers
 *
 * Uses the bundled ffmpeg (via @ffmpeg-installer/ffmpeg) so no system ffmpeg
 * is required, and node-webpmux to write sticker EXIF metadata.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffmpeg from "fluent-ffmpeg";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

let webpmux = null;
async function getWebpmux() {
  if (webpmux !== null) return webpmux;
  try {
    const mod = await import("node-webpmux");
    webpmux = mod.default || mod;
  } catch {
    webpmux = false;
  }
  return webpmux;
}

export const DEFAULT_METADATA = {
  packname: "GX-ID",
  author: "GX-ID",
  packId: "com.gxid.sticker",
  emojis: ["🤖"],
};

export function getTempDir() {
  const dir = path.join(process.cwd(), "storage", "temp");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function createExif(options = {}) {
  const packname = options.packname ?? DEFAULT_METADATA.packname;
  const author = options.author ?? DEFAULT_METADATA.author;
  const packId = options.packId ?? DEFAULT_METADATA.packId;
  const emojis = options.emojis ?? DEFAULT_METADATA.emojis;

  const json = {
    "sticker-pack-id": packId,
    "sticker-pack-name": packname,
    "sticker-pack-publisher": author,
    emojis,
    "is-avatar-sticker": 0,
    "android-app-store-link": "",
    "ios-app-store-link": "",
  };

  const exifAttr = Buffer.from([
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57,
    0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00,
  ]);
  const jsonBuffer = Buffer.from(JSON.stringify(json), "utf8");
  const exif = Buffer.concat([exifAttr, jsonBuffer]);
  exif.writeUIntLE(jsonBuffer.length, 14, 4);
  return exif;
}

function isWebp(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 12 && buffer.slice(0, 4).toString("hex") === "52494646";
}

export async function addExifToWebp(webpBuffer, options = {}) {
  const mux = await getWebpmux();
  if (!mux) return webpBuffer;
  try {
    const exif = createExif(options);
    const img = new mux.Image();
    await img.load(webpBuffer);
    img.exif = exif;
    return await img.save(null);
  } catch {
    return webpBuffer;
  }
}

function imageToWebpFFmpeg(buffer) {
  return new Promise((resolve, reject) => {
    const dir = getTempDir();
    const input = path.join(dir, `img_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.png`);
    const output = path.join(dir, `sticker_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.webp`);
    fs.writeFileSync(input, buffer);
    ffmpeg(input)
      .outputOptions([
        "-vcodec", "libwebp",
        "-vf", "scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000,setsar=1",
        "-loop", "0",
        "-preset", "default",
        "-an",
        "-vsync", "0",
        "-quality", "80",
      ])
      .toFormat("webp")
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

function videoToWebpFFmpeg(buffer, options = {}) {
  return new Promise((resolve, reject) => {
    const dir = getTempDir();
    const isGif = buffer.slice(0, 4).toString("hex") === "47494638";
    const ext = isGif ? "gif" : "mp4";
    const input = path.join(dir, `vid_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.${ext}`);
    const output = path.join(dir, `anim_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.webp`);
    fs.writeFileSync(input, buffer);
    const duration = options.duration || 6;
    const fps = options.fps || 15;
    ffmpeg(input)
      .inputOptions(["-y", "-t", String(duration)])
      .outputOptions([
        "-vcodec", "libwebp",
        "-vf", `fps=${fps},scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000,setsar=1`,
        "-loop", "0",
        "-preset", "default",
        "-an",
        "-vsync", "0",
      ])
      .toFormat("webp")
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

export async function createStickerFromImage(buffer, options = {}) {
  const webpBuffer = isWebp(buffer) ? buffer : await imageToWebpFFmpeg(buffer);
  return addExifToWebp(webpBuffer, options);
}

export async function createStickerFromVideo(buffer, options = {}) {
  const webpBuffer = isWebp(buffer) ? buffer : await videoToWebpFFmpeg(buffer, options);
  return addExifToWebp(webpBuffer, {
    packname: options.packname,
    author: options.author,
    emojis: options.emojis,
  });
}

export { ffmpeg, isWebp };
