/**
 * GX-ID — /videodl
 *
 * One command that detects the platform from the URL and downloads it:
 *
 *   .videodl <url>   (.vdl / .viddl / .dl)
 *
 *   YouTube            → picker (MP3 / MP4 per resolution) via native flow
 *                        (reuses the `.ytdl` flow logic in `src/scraper/ytdl.js`)
 *   Instagram          → reel / post / story / tv (via `src/scraper/ig.js`)
 *   TikTok             → video / slideshow (via tikwm.com)
 *   Facebook           → video / reel (via public resolver API)
 *
 * This plugin deliberately does NOT reuse the `.ytdl` native-flow namespace —
 * that namespace belongs to `plugins/download/ytdl.js`, and a second
 * `registerFlowRoute("ytdl", …)` would silently replace it. Instead YouTube
 * links here are downloaded straight to MP4 default quality; users who want the
 * format picker keep `.ytdl`.
 */
import axios from "axios";
import {
  isYouTubeUrl,
  normalizeYouTubeUrl,
  resolveVideo,
  resolveAudio,
  downloadBuffer,
  fallbackToMp3Buffer,
  toPlayableVideoBuffer,
} from "../../src/scraper/ytdl.js";
import instagramDownloader from "../../src/scraper/ig.js";

const pluginConfig = {
  name: "videodl",
  alias: ["vdl", "viddl", "dl"],
  category: "download",
  description: "Unduh video dari YouTube, Instagram, TikTok, Facebook dari satu link",
  usage: ".videodl <url>",
  examples: [
    ".videodl https://youtu.be/xxx",
    ".videodl https://www.instagram.com/reel/xxx",
    ".videodl https://vt.tiktok.com/xxx",
    ".videodl https://www.facebook.com/watch/?v=xxx",
  ],
  permission: "all",
  cooldown: 15,
  energi: 2,
  isEnabled: true,
};

const MAX_MEDIA_BYTES = 64 * 1024 * 1024;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const IG_RE = /instagram\.com\/(p|reel|reels|stories|tv|share)\//i;
const TIKTOK_RE = /(?:tiktok\.com|vt\.tiktok\.com|vm\.tiktok\.com)\//i;
const FB_RE = /(?:facebook\.com|fb\.watch|fb\.me)\//i;

function formatBytes(n) {
  if (!n) return "-";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + " GB";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + " MB";
  if (n >= 1e3) return (n / 1e3).toFixed(0) + " KB";
  return n + " B";
}

function safeName(title) {
  return String(title || "video").replace(/[\\/:*?"<>|\n\r]+/g, "_").slice(0, 80);
}

async function react(m, emoji) {
  try {
    await m.react(emoji);
  } catch {
    /* ignore */
  }
}

function extractUrl(text) {
  const match = String(text || "").match(/https?:\/\/[^\s]+/i);
  return match ? match[0] : "";
}

function platformOf(url) {
  if (isYouTubeUrl(url)) return "youtube";
  if (IG_RE.test(url)) return "instagram";
  if (TIKTOK_RE.test(url)) return "tiktok";
  if (FB_RE.test(url)) return "facebook";
  return null;
}

/* ─────────────────────────── YouTube ─────────────────────────── */

async function downloadYouTube(m, ctx, url) {
  const target = normalizeYouTubeUrl(url);
  const info = await resolveVideo(target, "720");
  if (!info?.url) throw new Error("Gagal mendapatkan video.");

  const buffer = await toPlayableVideoBuffer(info.url, info.audioUrl || null);
  if (buffer.length > MAX_MEDIA_BYTES) {
    throw new Error(`Ukuran video terlalu besar (${formatBytes(buffer.length)}). Coba \`.ytdl\` dan pilih resolusi lebih rendah.`);
  }

  const title = info.title || "YouTube";
  await ctx.sock.sendMessage(
    m.chat,
    {
      video: buffer,
      mimetype: "video/mp4",
      fileName: `${safeName(title)}.mp4`,
      caption: `🎬 *${title}*\n> YouTube • ${formatBytes(buffer.length)}`,
    },
    { quoted: m.raw },
  );
  return title;
}

/* ─────────────────────────── Instagram ─────────────────────────── */

async function downloadInstagram(m, ctx, url) {
  const result = await instagramDownloader(url);
  if (!result?.media?.length) throw new Error("Gagal mengambil media Instagram.");

  const isStory = /\/stories\//i.test(url);
  let caption = `📸 *Instagram ${isStory ? "Story" : "Downloader"}*\n`;
  if (result.username && result.username !== "-") caption += `👤 @${result.username}\n`;
  if (result.caption) caption += `📝 ${result.caption}\n`;

  for (const item of result.media) {
    const isVideo = item.type === "video" || item.type === "mp4";
    await ctx.sock.sendMessage(
      m.chat,
      isVideo
        ? { video: { url: item.url }, caption: caption.trim() }
        : { image: { url: item.url }, caption: caption.trim() },
      { quoted: m.raw },
    );
    caption = "";
  }
  return result.media.length;
}

/* ─────────────────────────── TikTok ─────────────────────────── */

async function downloadTikTok(m, ctx, url) {
  const { data } = await axios.get("https://tikwm.com/api/", {
    params: { url, hd: 1 },
    timeout: 25000,
    headers: { "User-Agent": UA },
  });
  if (!data || data.code !== 0) throw new Error("Gagal mengambil data TikTok.");

  const res = data.data;
  const title = (res.title || "-").replace(/\s+/g, " ").trim();
  const uploader = res.author?.nickname || res.author?.unique_id || "-";
  const caption = `🎵 *TikTok*\n👤 ${uploader}\n📝 ${title.slice(0, 120)}`.trim();

  if (Array.isArray(res.images) && res.images.length > 0) {
    for (let i = 0; i < res.images.length; i += 1) {
      await ctx.sock.sendMessage(
        m.chat,
        { image: { url: res.images[i] }, caption: i === 0 ? caption : "" },
        { quoted: m.raw },
      );
    }
  } else if (res.play) {
    await ctx.sock.sendMessage(
      m.chat,
      { video: { url: res.play }, caption },
      { quoted: m.raw },
    );
  } else {
    throw new Error("Tidak ada media yang bisa diunduh.");
  }
  return title;
}

/* ─────────────────────────── Facebook ─────────────────────────── */

async function downloadFacebook(m, ctx, url) {
  const { data } = await axios.get("https://api.azbry.com/api/download/facebook", {
    params: { url },
    timeout: 25000,
    headers: { "User-Agent": UA },
  });
  if (!data || data.status !== true || !Array.isArray(data.links) || !data.links.length) {
    throw new Error("Gagal mengambil media Facebook.");
  }

  const title = data.title || "Facebook";
  const caption = `📘 *Facebook*\n📝 ${String(title).slice(0, 120)}`.trim();

  for (const item of data.links) {
    const isVideo = /video|mp4/i.test(String(item.type || item.url || ""));
    await ctx.sock.sendMessage(
      m.chat,
      isVideo
        ? { video: { url: item.url }, caption }
        : { image: { url: item.url }, caption },
      { quoted: m.raw },
    );
  }
  return title;
}

/* ─────────────────────────── handler ─────────────────────────── */

const DISTRIBUTORS = {
  youtube: downloadYouTube,
  instagram: downloadInstagram,
  tiktok: downloadTikTok,
  facebook: downloadFacebook,
};

async function handler(m, ctx) {
  const url = extractUrl(m.text || m.quoted?.text || "");
  if (!url) {
    return m.reply(
      `📥 *VIDEO DOWNLOADER*\n\n` +
        `> \`${m.prefix}${m.command} <url>\`\n\n` +
        `Platform: YouTube, Instagram, TikTok, Facebook\n\n` +
        `> Contoh: \`${m.prefix}${m.command} https://www.instagram.com/reel/xxx\``,
    );
  }

  const platform = platformOf(url);
  if (!platform) {
    return m.reply("❌ Link tidak dikenali. Kirim link YouTube / Instagram / TikTok / Facebook.");
  }

  await react(m, "🕕");
  try {
    await DISTRIBUTORS[platform](m, ctx, url);
    await react(m, "✅");
  } catch (error) {
    await react(m, "❌");
    return m.reply(`❌ *Gagal mengunduh.*\n\n> ${error.message}`);
  }
}

export { pluginConfig as config, handler };
