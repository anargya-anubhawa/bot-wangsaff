/**
 * GX-ID — asset manager
 *
 * Assets may be local files or remote URLs. Remote URLs are fetched once at
 * boot so the synchronous `getAssetBuffer()` API keeps working. When an asset
 * is missing we generate a lightweight placeholder PNG so the UI never breaks.
 */
import fs from "fs";
import path from "path";
import axios from "axios";
import sharp from "sharp";
import { logger } from "./logger.js";
import config from "../config.js";

const assetCache = Object.create(null);
const remoteCache = new Map();
const placeholderCache = new Map();

function isRemoteUrl(value) {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

async function fetchRemoteBuffer(url, timeout = 30000) {
  if (!isRemoteUrl(url)) return null;
  if (remoteCache.has(url)) return remoteCache.get(url);
  const res = await axios.get(url, {
    responseType: "arraybuffer",
    timeout,
    maxContentLength: 50 * 1024 * 1024,
    maxBodyLength: 50 * 1024 * 1024,
    headers: { "User-Agent": "GX-ID-AssetLoader" },
  });
  const buffer = Buffer.from(res.data);
  remoteCache.set(url, buffer);
  return buffer;
}

/**
 * Build a gradient placeholder image (with the bot name) so menu/thumbnail
 * assets always resolve even when the user has not supplied any media.
 */
async function buildPlaceholder(label, key) {
  if (placeholderCache.has(key)) return placeholderCache.get(key);
  const width = 720;
  const height = 720;
  const safe = String(label || "GX-ID").replace(/[<>&]/g, "");
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#0f172a"/>
        <stop offset="55%" stop-color="#1e3a8a"/>
        <stop offset="100%" stop-color="#0ea5e9"/>
      </linearGradient>
    </defs>
    <rect width="${width}" height="${height}" fill="url(#g)"/>
    <circle cx="${width - 140}" cy="140" r="220" fill="rgba(255,255,255,0.06)"/>
    <circle cx="150" cy="${height - 120}" r="180" fill="rgba(255,255,255,0.05)"/>
    <text x="50%" y="47%" text-anchor="middle" fill="#ffffff" font-family="Arial, sans-serif" font-size="86" font-weight="800">${safe}</text>
    <text x="50%" y="58%" text-anchor="middle" fill="#bfdbfe" font-family="Arial, sans-serif" font-size="34" letter-spacing="6">WHATSAPP BOT</text>
  </svg>`;
  const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
  placeholderCache.set(key, buffer);
  return buffer;
}

export async function preloadAssets(configAssets) {
  if (!configAssets) return;
  for (const [key, value] of Object.entries(configAssets)) {
    try {
      if (typeof value === "string" && isRemoteUrl(value)) {
        const buffer = await fetchRemoteBuffer(value);
        if (buffer) {
          assetCache[key] = buffer;
          logger.system(`asset cached (remote): ${key}`);
        }
        continue;
      }
      if (typeof value === "string" && value) {
        const fullPath = path.resolve(process.cwd(), value);
        if (fs.existsSync(fullPath)) {
          assetCache[key] = fs.readFileSync(fullPath);
          logger.system(`asset loaded: ${key}`);
        } else {
          logger.warn(`asset not found: ${value} — using placeholder for "${key}"`);
        }
      }
    } catch (e) {
      logger.error(`asset "${key}" failed: ${e.message}`);
    }
  }
}

export function getAssetBuffer(key, configAssets = null) {
  if (assetCache[key]) return assetCache[key];
  const assets = configAssets || config?.assets;
  const value = assets?.[key];
  if (isRemoteUrl(value)) return null;
  if (typeof value === "string" && value) {
    try {
      const fullPath = path.resolve(process.cwd(), value);
      if (fs.existsSync(fullPath)) {
        const buf = fs.readFileSync(fullPath);
        assetCache[key] = buf;
        return buf;
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

/**
 * Async variant that always resolves to a usable image buffer, generating a
 * placeholder when the configured asset is missing/unavailable.
 */
export async function getImageBuffer(key, label = null) {
  const direct = getAssetBuffer(key);
  if (direct) return direct;
  const value = config?.assets?.[key];
  if (isRemoteUrl(value)) {
    try {
      const buf = await fetchRemoteBuffer(value);
      if (buf) {
        assetCache[key] = buf;
        return buf;
      }
    } catch {
      /* fall through to placeholder */
    }
  }
  return buildPlaceholder(label || config.bot?.name || "GX-ID", `ph:${key}:${label}`);
}

export async function getRemoteAssetBuffer(url) {
  return fetchRemoteBuffer(url);
}

export { buildPlaceholder, isRemoteUrl };
