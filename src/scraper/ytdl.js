/**
 * GX-ID — YouTube downloader
 *
 * A small, provider-agnostic downloader used by `plugins/download/*`
 * (`.ytmp3`, `.ytmp4`, `.play`, `.playlagu`, `.ytdl`).
 *
 * YouTube's own endpoints block datacenter IPs, so the module resolves media
 * through a chain of public resolver APIs and falls back gracefully when one is
 * down. Nothing here is a hardcoded *credential*: the endpoints are plain,
 * publicly-documented resolver URLs (the same ones the upstream plugins used)
 * and are centralised in `PROVIDERS` so they can be swapped in one place.
 *
 * Exports:
 *   default ytdl(url, type)          → { status, dl, title } | { status:false, mess }
 *   resolveAudio(url)                → { url, title, thumbnail, duration } | null
 *   resolveVideo(url, quality)       → { url, audioUrl, title, quality, … } | null
 *   resolveVideoQualities(url)       → { title, thumbnail, duration, qualities:[…] }
 *   searchYouTube(query, limit)      → [{ title, url, timestamp, thumbnail, author, views }]
 *   fallbackToMp3Buffer(source)      → Buffer (mp3)  — downloads + transcode when needed
 *   downloadBuffer(url)              → Buffer
 *   toPlayableVideoBuffer(video, audio) → Buffer (H.264/AAC faststart MP4)
 *   finalizeVideoBuffer(videoBuffer, audioBuffer) → Buffer (WhatsApp-ready MP4)
 *
 * Note: YouTube serves adaptive (DASH) streams where the video track has no
 * audio and may be VP9/AV1. `toPlayableVideoBuffer` muxes the audio back in,
 * transcodes to H.264 when needed and writes `+faststart` — otherwise WhatsApp
 * rejects the file as "something is wrong with the video file".
 */
import axios from "axios";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffmpeg from "fluent-ffmpeg";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** Default resolution ladder offered by `.ytdl`. */
export const VIDEO_QUALITIES = ["144", "240", "360", "480", "720", "1080"];

/**
 * Resolver endpoints. Each entry maps a URL + kind ("audio"|"video") to a
 * normalised `{ url, title, quality }` result through its own `parse` fn.
 * Order matters: the first provider that yields a playable URL wins.
 *
 * Providers may optionally expose `parseVideoQualities(data)` so a single
 * response can advertise every resolution it carries (used by `.ytdl`).
 */
const PROVIDERS = [
  {
    /* Primary: All-In-One downloader. Returns the full format ladder with
       proxied, directly-downloadable URLs — reliable across most videos. */
    name: "izuka-aio",
    audio: (u) => `https://my.izuka-api.xyz/api/downloader/aio-v2?url=${encodeURIComponent(u)}`,
    video: (u) => `https://my.izuka-api.xyz/api/downloader/aio-v2?url=${encodeURIComponent(u)}`,
    ok: (d) => d?.status === true && !!d?.result,
    parseAudio: (d) => {
      const a = pickAudioFormat(d?.result);
      if (!a) return null;
      return {
        url: a.url,
        title: d?.result?.title,
        thumbnail: d?.result?.thumbnail,
        duration: d?.result?.duration,
      };
    },
    parseVideo: (d, wanted) => {
      const v = pickVideoFormat(d?.result, wanted);
      if (!v) return null;
      return {
        url: v.url,
        audioUrl: pickAudioFormat(d?.result)?.url || null,
        title: d?.result?.title,
        thumbnail: d?.result?.thumbnail,
        duration: d?.result?.duration,
        quality: resolutionLabel(v.quality),
      };
    },
    parseVideoQualities: (d) => {
      const vids = (d?.result?.videos || []).filter(
        (v) => v?.url && !v.is_hls && resolutionLabel(v?.quality),
      );
      /* Only advertise MP4/H.264 resolutions — WebM/VP9 tracks are rejected by
         WhatsApp and are only used as a transcoded fallback, never offered. */
      const mp4 = vids.filter((v) => /mp4/i.test(String(v.format || "")));
      const pool = mp4.length ? mp4 : vids;
      return [...new Set(pool.map((v) => resolutionLabel(v.quality)).filter(Boolean))];
    },
  },
  {
    /* Secondary video: direct mp4 endpoint (older backend, often unavailable). */
    name: "izuka",
    audio: (u) => `https://my.izuka-api.xyz/api/downloader/ytmp3?url=${encodeURIComponent(u)}`,
    video: (u, q) =>
      `https://my.izuka-api.xyz/api/downloader/ytmp4?url=${encodeURIComponent(u)}` + (q ? `&quality=${q}` : ""),
    parseAudio: (d) => ({
      url: d?.result?.download_url || d?.result?.download,
      title: d?.result?.title,
    }),
    parseVideo: (d) => ({
      url: d?.result?.video_normal || d?.result?.video,
      title: d?.result?.title,
      thumbnail: d?.result?.thumb,
      duration: d?.result?.duration,
    }),
    ok: (d) => d?.status === true,
  },
  {
    /* Audio-only: `type=audio` variant of the yt-dl endpoint. */
    name: "izuka-ytdl",
    audio: (u) => `https://my.izuka-api.xyz/api/downloader/yt-dl?type=audio&url=${encodeURIComponent(u)}`,
    video: null,
    parseAudio: (d) => ({
      url: d?.result?.downloadUrl || d?.result?.url,
      title: d?.result?.title,
      thumbnail: d?.result?.thumbnail,
      duration: d?.result?.duration,
    }),
    ok: (d) => d?.status === true,
  },
  {
    name: "faa",
    audio: (u) => `https://api-faa.my.id/faa/ytmp3?url=${encodeURIComponent(u)}`,
    video: null,
    parseAudio: (d) => ({
      url: d?.result?.mp3,
      title: d?.result?.title,
      thumbnail: d?.result?.thumbnail,
      duration: d?.result?.duration,
    }),
    ok: (d) => d?.status === true,
  },
];

/* ─────────────────────── format selection helpers ─────────────────────── */

/** "1280x720" → "720"; returns null for non-dimension labels (e.g. "130kbps"). */
function resolutionLabel(quality) {
  const m = /^(\d{2,4})x(\d{2,4})$/.exec(String(quality || "").trim());
  return m ? m[2] : null;
}

function resolutionHeight(quality) {
  const label = resolutionLabel(quality);
  return label ? Number(label) : 0;
}

/**
 * Pick the best progressive video format from an AIO result.
 *
 * WhatsApp only plays H.264 (AVC) inside an MP4 container, so MP4 entries are
 * strongly preferred and WebM/VP9 entries are used only as a last resort (the
 * caller then transcodes them). Without `wanted`, the highest resolution wins;
 * with it, the smallest format that still meets the request (falling back to
 * the highest available). HLS-only entries are skipped.
 */
function pickVideoFormat(result, wanted) {
  const usable = (result?.videos || []).filter((v) => v?.url && resolutionLabel(v.quality) && !v.is_hls);
  if (!usable.length) return null;

  const isMp4 = (v) => /mp4/i.test(String(v.format || ""));
  const mp4 = usable.filter(isMp4);
  const pool = mp4.length ? mp4 : usable;

  const sorted = [...pool].sort((a, b) => {
    const byHeight = resolutionHeight(a.quality) - resolutionHeight(b.quality);
    if (byHeight !== 0) return byHeight;
    return (isMp4(a) ? 1 : 0) - (isMp4(b) ? 1 : 0);
  });
  const want = Number(String(wanted || "").replace(/\D/g, ""));
  if (!want) return sorted[sorted.length - 1];
  return sorted.find((v) => resolutionHeight(v.quality) >= want) || sorted[sorted.length - 1];
}

/** Pick an audio format, preferring an ffmpeg-friendly container. */
function pickAudioFormat(result) {
  const list = (result?.audios || []).filter((a) => a?.url);
  if (!list.length) return null;
  return list.find((a) => /mp4|m4a|aac/i.test(String(a.format || ""))) || list[0];
}

/* ─────────────────────────── url helpers ─────────────────────────── */

const YT_URL_RE =
  /^(?:https?:\/\/)?(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/|live\/)|youtu\.be\/)[\w-]{6,}/i;

/** True for any YouTube watch/short/live URL. */
export function isYouTubeUrl(value) {
  return typeof value === "string" && YT_URL_RE.test(value.trim());
}

/** Extract the 11-char video id from a YouTube URL, or `null`. */
export function extractVideoId(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  const patterns = [
    /(?:v=)([\w-]{11})/,
    /youtu\.be\/([\w-]{11})/,
    /youtube\.com\/shorts\/([\w-]{11})/,
    /youtube\.com\/embed\/([\w-]{11})/,
    /youtube\.com\/live\/([\w-]{11})/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[1];
  }
  return null;
}

/** Normalise any YouTube URL to `https://www.youtube.com/watch?v=<id>`. */
export function normalizeYouTubeUrl(value) {
  const id = extractVideoId(value);
  if (!id) return typeof value === "string" ? value.trim() : "";
  return `https://www.youtube.com/watch?v=${id}`;
}

/* ─────────────────────────── networking ─────────────────────────── */

/** Download any URL to a Buffer (bounded by `maxBytes`). */
export async function downloadBuffer(
  url,
  { timeout = 120000, maxBytes = 300 * 1024 * 1024, attempts = 3 } = {},
) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await axios.get(url, {
        responseType: "arraybuffer",
        timeout,
        maxContentLength: maxBytes,
        maxBodyLength: maxBytes,
        headers: { "User-Agent": UA, Accept: "*/*" },
      });
      const type = String(res.headers["content-type"] || "").toLowerCase();
      if (type.includes("text/html") || type.includes("application/json")) {
        throw new Error("URL download tidak mengembalikan media");
      }
      return Buffer.from(res.data);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(750 * attempt);
    }
  }
  throw lastError;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * GET a JSON endpoint with a couple of retries. Resolver APIs are flaky
 * (they time out or return 5xx in bursts), and a single transient failure must
 * not make `.ytdl` report "unduhan gagal".
 */
async function fetchJson(url, { timeout = 60000, attempts = 3 } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await axios.get(url, {
        timeout,
        headers: { "User-Agent": UA, Accept: "application/json, text/plain, */*" },
        validateStatus: () => true,
      });
      if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (typeof res.data === "string") {
        try {
          return JSON.parse(res.data);
        } catch {
          return null;
        }
      }
      return res.data;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(750 * attempt);
    }
  }
  throw lastError;
}

/* ─────────────────────────── resolvers ─────────────────────────── */

/**
 * Resolve an audio (mp3) download URL for a YouTube video.
 * @returns {Promise<{url:string,title?:string,thumbnail?:string,duration?:string}|null>}
 */
export async function resolveAudio(url) {
  const target = normalizeYouTubeUrl(url);
  for (const provider of PROVIDERS) {
    if (!provider.audio) continue;
    try {
      const data = await fetchJson(provider.audio(target));
      if (provider.ok(data)) {
        const parsed = provider.parseAudio(data);
        if (parsed?.url) return parsed;
      }
    } catch {
      /* try next provider */
    }
  }
  return null;
}

/**
 * Resolve a video (mp4) download URL for a YouTube video.
 * @param {string} url
 * @param {string|number|null} quality preferred resolution label ("360", 720…)
 * @returns {Promise<{url:string,title?:string,quality?:string,thumbnail?:string,duration?:string}|null>}
 */
export async function resolveVideo(url, quality = null) {
  const target = normalizeYouTubeUrl(url);
  const wanted = quality ? String(quality).replace(/p$/i, "") : null;
  for (const provider of PROVIDERS) {
    if (!provider.video) continue;
    try {
      const data = await fetchJson(provider.video(target, wanted));
      if (provider.ok(data)) {
        const parsed = provider.parseVideo(data, wanted);
        if (parsed?.url) return { ...parsed, quality: wanted || parsed.quality || null };
      }
    } catch {
      /* try next provider */
    }
  }
  return null;
}

/**
 * Best-effort metadata + available resolutions for `.ytdl`.
 * Resolutions are reported from the provider's `itag` when detectable, else the
 * default ladder is advertised (the provider returns the closest match).
 */
export async function resolveVideoQualities(url) {
  const target = normalizeYouTubeUrl(url);
  let meta = { title: null, thumbnail: null, duration: null };
  const available = new Set();

  for (const provider of PROVIDERS) {
    if (!provider.video) continue;
    try {
      const data = await fetchJson(provider.video(target, null));
      if (!provider.ok(data)) continue;
      const parsed = provider.parseVideo(data, null);
      if (!parsed?.url) continue;
      meta = {
        title: parsed.title || meta.title,
        thumbnail: parsed.thumbnail || meta.thumbnail,
        duration: parsed.duration || meta.duration,
      };
      /* Prefer the provider's own ladder (e.g. AIO lists every resolution). */
      const reported = provider.parseVideoQualities?.(data) || [];
      for (const label of reported) available.add(label);
      if (!available.size) {
        const itag = (parsed.url.match(/[?&]itag=(\d+)/) || [])[1];
        const label = ITAG_LABEL[itag];
        if (label) available.add(label);
      }
      break;
    } catch {
      /* try next */
    }
  }

  const qualities = available.size ? [...available].sort((a, b) => Number(a) - Number(b)) : [...VIDEO_QUALITIES];
  return { ...meta, qualities };
}

/** Common progressive itag → resolution label. */
const ITAG_LABEL = {
  17: "144",
  18: "360",
  22: "720",
  59: "480",
  78: "480",
  133: "240",
  134: "360",
  135: "480",
  136: "720",
  137: "1080",
  160: "144",
  242: "240",
  243: "360",
  244: "480",
  247: "720",
  248: "1080",
};

/* ─────────────────────────── search ─────────────────────────── */

/**
 * Search YouTube via `yt-search`.
 * @returns {Promise<Array<{title:string,url:string,timestamp:string,thumbnail:string,author:string,views:number}>>}
 */
export async function searchYouTube(query, limit = 1) {
  const yts = (await import("yt-search")).default;
  const result = await yts(query);
  const videos = Array.isArray(result?.videos) ? result.videos : [];
  return videos.slice(0, Math.max(1, limit)).map((v) => ({
    title: v.title,
    url: v.url,
    timestamp: v.timestamp,
    thumbnail: v.thumbnail,
    author: v.author?.name || v.author || "",
    views: v.views || 0,
  }));
}

/** Convenience: resolve a search query or URL into a canonical watch URL. */
export async function resolveQueryToUrl(query) {
  const text = String(query || "").trim();
  if (isYouTubeUrl(text)) return normalizeYouTubeUrl(text);
  const [first] = await searchYouTube(text, 1);
  if (!first) return null;
  return normalizeYouTubeUrl(first.url);
}

/* ─────────────────────────── transcode ─────────────────────────── */

function looksLikeMp3(buffer) {
  if (!buffer || buffer.length < 4) return false;
  if (buffer.slice(0, 3).toString("latin1") === "ID3") return true;
  // MPEG audio frame sync (0xFFE0 mask).
  return buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0;
}

/**
 * Convert any media buffer/URL into an mp3 Buffer using the bundled ffmpeg.
 * Already-mp3 input is returned untouched.
 * @param {Buffer|string} source
 * @returns {Promise<Buffer>}
 */
export async function fallbackToMp3Buffer(source) {
  const buffer = Buffer.isBuffer(source) ? source : await downloadBuffer(source);
  if (looksLikeMp3(buffer)) return buffer;

  const id = crypto.randomBytes(8).toString("hex");
  const inPath = path.join(os.tmpdir(), `gx-ytdl-${id}.src`);
  const outPath = path.join(os.tmpdir(), `gx-ytdl-${id}.mp3`);

  await fs.promises.writeFile(inPath, buffer);
  try {
    await new Promise((resolve, reject) => {
      ffmpeg(inPath)
        .noVideo()
        .audioCodec("libmp3lame")
        .audioBitrate(192)
        .format("mp3")
        .on("error", reject)
        .on("end", resolve)
        .save(outPath);
    });
    return await fs.promises.readFile(outPath);
  } finally {
    fs.promises.unlink(inPath).catch(() => {});
    fs.promises.unlink(outPath).catch(() => {});
  }
}

/**
 * Probe a media file with ffprobe.
 * @returns {Promise<{videoCodec: string|null, hasAudio: boolean}>}
 */
async function probeStreams(file) {
  try {
    const data = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(file, (err, meta) => (err ? reject(err) : resolve(meta)));
    });
    const streams = data?.streams || [];
    return {
      videoCodec: streams.find((s) => s.codec_type === "video")?.codec_name || null,
      hasAudio: streams.some((s) => s.codec_type === "audio"),
    };
  } catch {
    return { videoCodec: null, hasAudio: false };
  }
}

/**
 * Normalise a downloaded video into a WhatsApp-playable MP4.
 *
 * YouTube serves adaptive (DASH) streams in which the video track carries no
 * audio and may use a non-H.264 codec (VP9/AV1). WhatsApp rejects such files
 * with "This video is not available because something is wrong with the video
 * file". This function muxes the separate audio track back in, copies the
 * video stream when it is already H.264 (fast) and transcodes it otherwise,
 * and rewrites the container with `+faststart` (moov atom first).
 *
 * @param {Buffer} videoBuffer video track
 * @param {Buffer|null} audioBuffer separate audio track, when the provider gave one
 * @returns {Promise<Buffer>}
 */
export async function finalizeVideoBuffer(videoBuffer, audioBuffer = null) {
  const id = crypto.randomBytes(8).toString("hex");
  const inVideo = path.join(os.tmpdir(), `gx-ytdl-${id}.v.mp4`);
  const inAudio = audioBuffer ? path.join(os.tmpdir(), `gx-ytdl-${id}.a.m4a`) : null;
  const outPath = path.join(os.tmpdir(), `gx-ytdl-${id}.out.mp4`);

  await fs.promises.writeFile(inVideo, videoBuffer);
  if (inAudio) await fs.promises.writeFile(inAudio, audioBuffer);

  try {
    const { videoCodec, hasAudio } = await probeStreams(inVideo);
    const withAudio = !!inAudio || hasAudio;

    await new Promise((resolve, reject) => {
      const cmd = ffmpeg(inVideo);
      if (inAudio) cmd.input(inAudio);

      if (videoCodec === "h264") {
        cmd.videoCodec("copy");
      } else {
        cmd
          .videoCodec("libx264")
          .outputOptions(["-preset", "veryfast", "-crf", "26", "-pix_fmt", "yuv420p"]);
      }

      if (withAudio) cmd.audioCodec("aac").audioBitrate(128);
      else cmd.noAudio();

      const extra = ["-movflags", "+faststart"];
      if (withAudio) extra.push("-shortest");

      cmd
        .outputOptions(extra)
        .format("mp4")
        .on("error", reject)
        .on("end", resolve)
        .save(outPath);
    });
    return await fs.promises.readFile(outPath);
  } finally {
    fs.promises.unlink(inVideo).catch(() => {});
    if (inAudio) fs.promises.unlink(inAudio).catch(() => {});
    fs.promises.unlink(outPath).catch(() => {});
  }
}

/**
 * Backwards-compatible wrapper: mux a video track with a separate audio track.
 * @deprecated prefer {@link finalizeVideoBuffer}
 */
export async function muxToMp4Buffer(video, audio) {
  const videoBuffer = Buffer.isBuffer(video) ? video : await downloadBuffer(video);
  const audioBuffer = Buffer.isBuffer(audio) ? audio : await downloadBuffer(audio);
  return finalizeVideoBuffer(videoBuffer, audioBuffer);
}

/**
 * Produce a WhatsApp-playable MP4 from a resolved video track (and its
 * separate audio track, when the provider gave one).
 *
 * @param {Buffer|string} videoSource video track (buffer or URL)
 * @param {Buffer|string|null} audioSource audio track (buffer or URL), if any
 * @returns {Promise<Buffer>}
 */
export async function toPlayableVideoBuffer(videoSource, audioSource = null) {
  const videoBuffer = Buffer.isBuffer(videoSource) ? videoSource : await downloadBuffer(videoSource);
  const audioBuffer = audioSource
    ? Buffer.isBuffer(audioSource)
      ? audioSource
      : await downloadBuffer(audioSource)
    : null;
  return finalizeVideoBuffer(videoBuffer, audioBuffer);
}

/* ─────────────────────────── legacy API ─────────────────────────── */

/**
 * GX-ID style resolver kept for backward compatibility with the download
 * plugins: `ytdl(url, "mp3" | "mp4")`.
 * @returns {Promise<{status:boolean, dl?:string, title?:string, mess?:string}>}
 */
export default async function ytdl(url, type = "mp4") {
  try {
    const kind = String(type || "mp4").toLowerCase();
    if (kind === "mp3" || kind === "audio") {
      const info = await resolveAudio(url);
      if (info?.url) return { status: true, dl: info.url, title: info.title };
      return { status: false, mess: "Gagal mendapatkan audio" };
    }
    const info = await resolveVideo(url, null);
    if (info?.url) return { status: true, dl: info.url, title: info.title };
    return { status: false, mess: "Gagal mendapatkan video" };
  } catch (error) {
    return { status: false, mess: error.message };
  }
}
