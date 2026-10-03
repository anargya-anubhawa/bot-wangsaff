/**
 * GX-ID — /ytdl
 *
 * One command for downloading a YouTube video or its audio, with a Native Flow
 * bottom-sheet so the user picks the format/resolution with a single tap:
 *
 *   .ytdl <url|judul>        → show the picker (🎵 MP3 + 🎬 MP4 per resolusi)
 *   .ytdl mp3 <url|judul>    → skip the picker, send MP3 directly
 *   .ytdl 720 <url|judul>    → skip the picker, send MP4 (best-effort 720p)
 *   .ytdl mp4 <url|judul>    → skip the picker, send MP4 (default quality)
 *
 * The tap carries no arguments, so the resolved video is parked in the
 * short-lived flow context (`lib/flow-context.js`) and read back when the row
 * is selected.
 */
import { registerFlowRoute } from "../../lib/flow-router.js";
import { sendNativeFlow, createSingleSelect } from "../../lib/flow.js";
import { setFlowContext, getFlowContext, clearFlowContext } from "../../lib/flow-context.js";
import {
  isYouTubeUrl,
  normalizeYouTubeUrl,
  searchYouTube,
  resolveVideoQualities,
  resolveAudio,
  resolveVideo,
  downloadBuffer,
  fallbackToMp3Buffer,
  toPlayableVideoBuffer,
} from "../../src/scraper/ytdl.js";

const NS = "ytdl";

/** WhatsApp caps video/document uploads around this size; warn above it. */
const MAX_MEDIA_BYTES = 64 * 1024 * 1024;

const pluginConfig = {
  name: "ytdl",
  alias: ["youtubedl", "ytdownload"],
  category: "download",
  description: "Unduh video/audio YouTube (pilih format lewat tombol)",
  usage: ".ytdl <url|judul>",
  examples: [".ytdl komang", ".ytdl mp3 komang", ".ytdl 720 https://youtu.be/xxx"],
  permission: "all",
  cooldown: 15,
  energi: 2,
  isEnabled: true,
};

/* ─────────────────────────── helpers ─────────────────────────── */

function formatBytes(n) {
  if (!n) return "-";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + " GB";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + " MB";
  if (n >= 1e3) return (n / 1e3).toFixed(0) + " KB";
  return n + " B";
}

function safeName(title) {
  return String(title || "youtube").replace(/[\\/:*?"<>|\n\r]+/g, "_").slice(0, 80);
}

/**
 * Split the user's text into an optional format hint + the query itself.
 * @returns {{format: "mp3"|"mp4"|null, quality: string|null, query: string}}
 */
function parseArgs(text) {
  const parts = String(text || "").trim().split(/\s+/).filter(Boolean);
  let format = null;
  let quality = null;

  const first = (parts[0] || "").toLowerCase();
  if (first === "mp3" || first === "audio") {
    format = "mp3";
    parts.shift();
  } else if (first === "mp4" || first === "video") {
    format = "mp4";
    parts.shift();
  } else if (/^\d{3,4}p?$/.test(first)) {
    format = "mp4";
    quality = first.replace(/p$/i, "");
    parts.shift();
  }

  return { format, quality, query: parts.join(" ").trim() };
}

/** Resolve a query/URL into `{ url, title, thumbnail, duration, qualities }`. */
async function resolveTarget(query) {
  let url;
  let fallbackTitle;
  if (isYouTubeUrl(query)) {
    url = normalizeYouTubeUrl(query);
  } else {
    const [first] = await searchYouTube(query, 1);
    if (!first) return null;
    url = normalizeYouTubeUrl(first.url);
    fallbackTitle = first.title;
  }

  const meta = await resolveVideoQualities(url).catch(() => null);
  return {
    url,
    title: meta?.title || fallbackTitle || "YouTube",
    thumbnail: meta?.thumbnail || null,
    duration: meta?.duration || null,
    qualities: meta?.qualities || [],
  };
}

/* ─────────────────────────── picker (flow) ─────────────────────────── */

async function sendPicker(m, ctx, target) {
  setFlowContext(NS, m.chat, m.sender, target);

  const rows = [{ id: `${NS}:audio`, title: "🎵 Audio (MP3)", description: "Konversi ke MP3" }];
  for (const q of target.qualities) {
    rows.push({
      id: `${NS}:video:${q}`,
      title: `🎬 Video ${q}p`,
      description: "MP4 • resolusi terbaik yang tersedia",
    });
  }

  const select = createSingleSelect({
    title: "Pilih format",
    sectionTitle: "Format unduhan",
    rows,
  });

  const header =
    `📥 *YouTube Downloader*\n\n` +
    `📌 *Judul:* ${target.title}\n` +
    (target.duration ? `⏱️ *Durasi:* ${target.duration}\n` : "") +
    `\n> Ketuk tombol di bawah untuk memilih format.`;

  const sent = await sendNativeFlow(ctx.sock, m.chat, {
    body: header,
    footer: "Pilih format unduhan",
    buttons: [select],
    quoted: m.raw,
    fallbackLabel: "ytdl",
  });

  if (!sent) {
    // No flow support: fall back to a text menu the user can act on by command.
    const list = target.qualities.map((q) => `┃ 🎬 Video \`${q}p\``).join("\n");
    await m.reply(
      `📥 *YouTube Downloader*\n\n` +
        `📌 *Judul:* ${target.title}\n\n` +
        `╭─〔 format 〕\n┃ 🎵 Audio \`mp3\`\n${list}\n╰─⬣\n\n` +
        `> Contoh: \`${m.prefix}ytdl mp3 ${target.url}\`\n` +
        `> Contoh: \`${m.prefix}ytdl 720 ${target.url}\``,
    );
  }
  return sent;
}

/* ─────────────────────────── download & send ─────────────────────────── */

async function sendAudio(m, ctx, target) {
  const info = await resolveAudio(target.url);
  if (!info?.url) throw new Error("Gagal mendapatkan audio.");

  const raw = await downloadBuffer(info.url);
  const mp3 = await fallbackToMp3Buffer(raw);
  if (mp3.length > MAX_MEDIA_BYTES) {
    throw new Error(`Ukuran audio terlalu besar (${formatBytes(mp3.length)}).`);
  }

  const title = info.title || target.title;
  await ctx.sock.sendMessage(
    m.chat,
    {
      audio: mp3,
      mimetype: "audio/mpeg",
      ptt: false,
      fileName: `${safeName(title)}.mp3`,
    },
    { quoted: m.raw },
  );
  return title;
}

/** Resolutions to try, highest first, when a download exceeds the size cap. */
const STEP_DOWN = ["1080", "720", "480", "360", "240", "144"];

/**
 * Try `resolveVideo` + mux for the requested quality, stepping down to lower
 * resolutions when the resulting file is larger than WhatsApp accepts.
 * @returns {Promise<{buffer: Buffer, info: object}>}
 */
async function downloadVideoWithinLimit(target, quality) {
  const ladder = quality ? [String(quality)] : [];
  const start = STEP_DOWN.indexOf(String(quality || ""));
  ladder.push(...(start >= 0 ? STEP_DOWN.slice(start + 1) : STEP_DOWN));

  let lastError = null;
  for (const q of ladder) {
    let info;
    try {
      info = await resolveVideo(target.url, q);
    } catch (error) {
      lastError = error;
      continue;
    }
    if (!info?.url) {
      lastError = new Error("Gagal mendapatkan video.");
      continue;
    }

    let buffer;
    try {
      buffer = await toPlayableVideoBuffer(info.url, info.audioUrl || null);
    } catch (error) {
      lastError = error;
      continue;
    }

    if (buffer.length <= MAX_MEDIA_BYTES) {
      return { buffer, info, quality: info.quality || q };
    }
    /* Too large — fall through and try the next, smaller resolution. */
    lastError = new Error(`Ukuran video terlalu besar (${formatBytes(buffer.length)}).`);
  }
  throw lastError || new Error("Gagal mendapatkan video.");
}

async function sendVideo(m, ctx, target, quality) {
  const { buffer, info, quality: usedQuality } = await downloadVideoWithinLimit(target, quality);

  const title = info.title || target.title;
  const caption =
    `🎬 *${title}*\n` +
    (usedQuality ? `> Resolusi: *${usedQuality}p*\n` : "") +
    `> Ukuran: *${formatBytes(buffer.length)}*`;

  await ctx.sock.sendMessage(
    m.chat,
    {
      video: buffer,
      mimetype: "video/mp4",
      fileName: `${safeName(title)}.mp4`,
      caption,
    },
    { quoted: m.raw },
  );
  return title;
}

/* ─────────────────────────── flow route ─────────────────────────── */

registerFlowRoute(NS, async (m, ctx, action) => {
  const target = getFlowContext(NS, m.chat, m.sender);
  if (!target?.url) {
    await m.reply(`⏳ *Sesi kedaluwarsa.*\n\n> Ulangi: \`${m.prefix}ytdl <judul/url>\``);
    return true;
  }

  const react = async (emoji) => {
    try {
      await m.react(emoji);
    } catch {
      /* ignore */
    }
  };

  try {
    if (action.action === "audio") {
      await react("🕕");
      const title = await sendAudio(m, ctx, target);
      await react("✅");
      clearFlowContext(NS, m.chat, m.sender);
      await m.reply(`✅ *Audio terkirim.*\n\n📌 ${title}`);
      return true;
    }

    if (action.action === "video") {
      const quality = action.args[0] || null;
      await react("🕕");
      const title = await sendVideo(m, ctx, target, quality);
      await react("✅");
      clearFlowContext(NS, m.chat, m.sender);
      await m.reply(`✅ *Video terkirim.*\n\n📌 ${title}`);
      return true;
    }
  } catch (error) {
    await react("❌");
    await m.reply(`❌ *Unduhan gagal.*\n\n> ${error.message}`);
    return true;
  }

  return false;
});

/* ─────────────────────────── handler ─────────────────────────── */

async function handler(m, ctx) {
  const { format, quality, query } = parseArgs(m.text);
  if (!query) {
    return m.reply(
      `📥 *YOUTUBE DOWNLOADER*\n\n` +
        `> \`${m.prefix}${m.command} <judul/url>\` — pilih format lewat tombol\n` +
        `> \`${m.prefix}${m.command} mp3 <judul/url>\` — langsung MP3\n` +
        `> \`${m.prefix}${m.command} 720 <judul/url>\` — langsung MP4`,
    );
  }

  try {
    await m.react("🔍");
  } catch {
    /* ignore */
  }

  let target;
  try {
    target = await resolveTarget(query);
  } catch (error) {
    target = null;
  }
  if (!target) {
    return m.reply(`❌ *Tidak ditemukan.*\n\n> Coba judul lain atau tempel URL YouTube langsung.`);
  }

  // Explicit format requested → skip the picker.
  if (format) {
    try {
      if (format === "mp3") {
        await m.react("🕕");
        const title = await sendAudio(m, ctx, target);
        await m.react("✅");
        return m.reply(`✅ *Audio terkirim.*\n\n📌 ${title}`);
      }
      await m.react("🕕");
      const title = await sendVideo(m, ctx, target, quality);
      await m.react("✅");
      return m.reply(`✅ *Video terkirim.*\n\n📌 ${title}`);
    } catch (error) {
      await m.react("❌");
      return m.reply(`❌ *Unduhan gagal.*\n\n> ${error.message}`);
    }
  }

  await sendPicker(m, ctx, target);
}

export { pluginConfig as config, handler };
