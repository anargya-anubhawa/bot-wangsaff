/**
 * GX-ID — pending PDF→format jobs
 *
 * A `.unpdf` invocation downloads the PDF, shows an interactive format picker
 * and then *waits* for the user to tap a row. The tap arrives as a separate,
 * stateless flow message, so the downloaded bytes have to be kept somewhere
 * between the two messages.
 *
 * This module is that somewhere: a small, TTL-bounded, in-memory store keyed by
 * a random token. Entries carry the originating chat so a token minted in one
 * chat can never be redeemed from another. Nothing is written to disk.
 */
import crypto from "crypto";
import NodeCache from "node-cache";

/** How long a picker stays valid (seconds). */
const TTL_SECONDS = Number(process.env.PDF_JOB_TTL_SECONDS) || 15 * 60;

/** Maximum number of pending jobs kept at once (LRU-ish; oldest evicted). */
const MAX_JOBS = Number(process.env.PDF_JOB_MAX) || 50;

/** Hard cap on a single stored PDF, so the cache can't be used to exhaust RAM. */
const MAX_BYTES = (Number(process.env.PDF_MAX_SIZE_MB) || 25) * 1024 * 1024;

const cache = new NodeCache({ stdTTL: TTL_SECONDS, checkperiod: 60, useClones: false });

/** Mint a new token for `{ buffer, fileName, chat, sender }`. */
export function createJob({ buffer, fileName = "", chat = "", sender = "" } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  if (buffer.length > MAX_BYTES) return null;

  // Evict the oldest entry when at capacity (NodeCache keys() is insertion-ordered).
  const keys = cache.keys();
  while (keys.length >= MAX_JOBS) {
    const oldest = keys.shift();
    cache.del(oldest);
  }

  const token = crypto.randomBytes(9).toString("hex");
  cache.set(token, { buffer, fileName, chat, sender, createdAt: Date.now() });
  return token;
}

/**
 * Fetch a job. When `chat` is supplied the entry must belong to that chat,
 * otherwise `null` is returned (so a token cannot be redeemed cross-chat).
 */
export function getJob(token, chat = null) {
  const entry = cache.get(String(token || ""));
  if (!entry) return null;
  if (chat && entry.chat && entry.chat !== chat) return null;
  return entry;
}

/** Drop a job once it has been used (or is no longer needed). */
export function dropJob(token) {
  cache.del(String(token || ""));
}

/** Test helper — wipe every pending job. */
export function clearJobs() {
  cache.flushAll();
}

/** Number of pending jobs (diagnostics/tests). */
export function jobCount() {
  return cache.keys().length;
}
