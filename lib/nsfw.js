/**
 * GX-ID — NSFW classification
 *
 * Two interchangeable backends, picked at runtime:
 *
 *   1. REMOTE (default when `NSFW_API_URL` is set) — the image is POSTed there
 *      and the JSON reply is read as `{ nsfw: boolean }` (also accepts
 *      `{ safe }` / `{ label }`). No key is hardcoded; an optional
 *      `NSFW_API_KEY` is forwarded as a bearer token.
 *
 *   2. LOCAL (fallback) — an on-device `nsfwjs` + `@tensorflow/tfjs` model
 *      (MobileNetV2). Nothing leaves the server. The model ships inside the
 *      `nsfwjs` package, so it loads OFFLINE — no CDN fetch, no API needed.
 *
 * Both backends expose the same contract — `{ available, isNsfw, score }` — so
 * the moderation pipeline never needs to know which one ran. Any failure
 * degrades to `available: false` (the message is left alone) rather than
 * blocking traffic or pretending to have classified something.
 *
 * Animated media (video / GIF / animated sticker) is not a single frame, so it
 * is sampled with the bundled ffmpeg: a handful of frames spread across the
 * clip are classified independently and the clip is flagged if ANY sampled
 * frame crosses the threshold. This is a sampling heuristic, not a full scan.
 */
import path from "path";
import os from "os";
import fs from "fs";
import { createRequire } from "module";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffmpeg from "fluent-ffmpeg";
import { logger } from "./logger.js";

/**
 * `nsfwjs`'s ESM build has a broken `buffer` directory import on Node, and its
 * CJS build must share the EXACT same `@tensorflow/tfjs` instance as our tensor
 * creation (two instances would reject each other's tensors). Loading both
 * through one CommonJS `require` guarantees a single, shared tf registry.
 */
const require = createRequire(import.meta.url);
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

/** NSFWJS output classes that count as "not safe" for this bot. */
const NSFW_CLASSES = new Set(["Porn", "Hentai", "Sexy"]);

/* Read per call (not at import) so the threshold/frame count can be tuned at
   runtime and exercised by tests without re-importing the module. */
function threshold() {
  const n = Number(process.env.NSFW_THRESHOLD ?? 0.75);
  return Number.isFinite(n) ? n : 0.75;
}

function videoFrameSamples() {
  const n = Number(process.env.NSFW_VIDEO_FRAME_SAMPLES ?? 4);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 4;
}

/** Lazily-loaded { tf, model } shared across every classification. */
let localPromise = null;

function localModelEnabled() {
  return String(process.env.NSFW_LOCAL_MODEL ?? "true").toLowerCase() !== "false";
}

/**
 * True when *some* backend can classify — an API URL is set, or the local
 * model is enabled. `.antinsfw` is a no-op only when this is false.
 */
export function isNsfwDetectorConfigured() {
  return !!process.env.NSFW_API_URL || localModelEnabled();
}

/** Load the local model once; a failure is not cached, so it can retry later. */
async function getLocal() {
  if (localPromise) return localPromise;
  localPromise = (async () => {
    const tf = require("@tensorflow/tfjs");
    const nsfwjs = require("nsfwjs");
    const model = await nsfwjs.load();
    logger.info("[NSFW] local model ready (MobileNetV2, on-device)");
    return { tf, model };
  })().catch((error) => {
    localPromise = null;
    throw error;
  });
  return localPromise;
}

/** Combine predictions into a single verdict (sum of NSFW-class probabilities). */
function summarize(predictions) {
  if (!Array.isArray(predictions) || !predictions.length) {
    return { available: false, isNsfw: false };
  }
  let topClass = predictions[0].className;
  let score = 0;
  for (const p of predictions) {
    if (p.probability > (predictions.find((x) => x.className === topClass)?.probability ?? -1)) {
      topClass = p.className;
    }
    if (NSFW_CLASSES.has(p.className)) score += p.probability;
  }
  return { available: true, isNsfw: score >= threshold(), score, topClass, predictions };
}

/** Decode an image buffer into the int32 [h, w, 3] tensor NSFWJS expects. */
async function bufferToTensor(tf, buffer) {
  const sharp = require("sharp");
  const { data, info } = await sharp(buffer)
    .removeAlpha()
    .toColorspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 3) {
    throw new Error(`unexpected channel count ${info.channels}`);
  }
  return tf.tensor3d(new Int32Array(data), [info.height, info.width, 3], "int32");
}

/** Classify one static frame with the local model. */
async function classifyLocal(buffer) {
  const { tf, model } = await getLocal();
  const tensor = await bufferToTensor(tf, buffer);
  try {
    const predictions = await model.classify(tensor);
    return summarize(predictions);
  } finally {
    tensor.dispose();
  }
}

/** Classify one image through the configured HTTP endpoint. */
async function classifyRemote(buffer) {
  const url = process.env.NSFW_API_URL;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const headers = { "Content-Type": "application/json" };
    if (process.env.NSFW_API_KEY) headers.Authorization = `Bearer ${process.env.NSFW_API_KEY}`;
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ image: buffer.toString("base64") }),
      signal: controller.signal,
    });
    if (!res.ok) {
      logger.warn(`[NSFW] classifier HTTP ${res.status}`);
      return { available: false, isNsfw: false };
    }
    const data = await res.json().catch(() => null);
    if (!data || typeof data !== "object") return { available: false, isNsfw: false };

    const score = typeof data.score === "number" ? data.score : undefined;
    let isNsfw = false;
    if (typeof data.nsfw === "boolean") isNsfw = data.nsfw;
    else if (typeof data.safe === "boolean") isNsfw = !data.safe;
    else if (typeof data.label === "string") isNsfw = /nsfw|porn|explicit|adult/i.test(data.label);
    return { available: true, isNsfw, score };
  } catch (error) {
    logger.warn(`[NSFW] classifier unavailable: ${error.message}`);
    return { available: false, isNsfw: false };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Classify a single static image (jpeg/png/webp/etc.) buffer.
 *
 * @param {Buffer} buffer
 * @returns {Promise<{available:boolean, isNsfw:boolean, score?:number, topClass?:string}>}
 */
export async function classifyImageBuffer(buffer) {
  if (!buffer?.length) return { available: false, isNsfw: false };
  if (process.env.NSFW_API_URL) return classifyRemote(buffer);
  if (!localModelEnabled()) return { available: false, isNsfw: false };
  try {
    return await classifyLocal(buffer);
  } catch (error) {
    logger.warn(`[NSFW] local classifier unavailable: ${error.message}`);
    return { available: false, isNsfw: false };
  }
}

/**
 * Classify an animated buffer by sampling frames. The clip is flagged when ANY
 * sampled frame is NSFW; the highest-scoring frame wins.
 *
 * @param {Buffer} buffer
 * @param {string} mimetypeHint
 * @returns {Promise<{available:boolean, isNsfw:boolean, score?:number, topClass?:string}>}
 */
export async function classifyAnimatedBuffer(buffer, mimetypeHint = "") {
  if (!buffer?.length) return { available: false, isNsfw: false };
  // The remote backend classifies a single image only — sample frames locally.
  if (!localModelEnabled()) return { available: false, isNsfw: false };

  let tmpDir = null;
  try {
    const samples = videoFrameSamples();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gxid-nsfw-"));
    tmpDir = tmp;
    const ext = /gif/i.test(mimetypeHint) ? "gif" : /webp/i.test(mimetypeHint) ? "webp" : "mp4";
    const inputPath = path.join(tmp, `input.${ext}`);
    const framePattern = path.join(tmp, "frame-%02d.png");
    fs.writeFileSync(inputPath, buffer);

    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .outputOptions(["-vf", "fps=2", "-frames:v", String(samples)])
        .output(framePattern)
        .on("end", () => resolve())
        .on("error", (err) => reject(err))
        .run();
    });

    const frames = fs
      .readdirSync(tmp)
      .filter((f) => f.startsWith("frame-"))
      .sort();

    let worst = { available: true, isNsfw: false, score: 0, topClass: "Safe" };
    let classifiedAny = false;
    for (const frame of frames) {
      const frameBuffer = fs.readFileSync(path.join(tmp, frame));
      try {
        const result = await classifyLocal(frameBuffer);
        if (!result.available) continue;
        classifiedAny = true;
        if ((result.score ?? 0) > (worst.score ?? 0)) worst = result;
      } catch (error) {
        logger.warn(`[NSFW] frame classification failed: ${error.message}`);
      }
    }
    if (!classifiedAny) return { available: false, isNsfw: false };
    return worst;
  } catch (error) {
    logger.warn(`[NSFW] animated classification unavailable: ${error.message}`);
    return { available: false, isNsfw: false };
  } finally {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
