/**
 * GX-ID — confirmation service
 *
 * Short-lived, single-use confirmations for destructive bulk actions
 * (`.kickall`, `.purge`). A confirmation is bound to a specific
 * (user, chat, action) triple so nobody else can trigger it, and it expires
 * after a TTL. The map is swept periodically to stay bounded.
 */
import { randomUUID } from "crypto";

const DEFAULT_TTL_MS = 60_000;

/** token → { user, chat, action, stage, data, expiresAt } */
const confirmations = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of confirmations) {
    if (entry.expiresAt <= now) confirmations.delete(token);
  }
}, 30_000).unref?.();

function key(user, chat, action) {
  return `${user}|${chat}|${action}`;
}

/**
 * Create (or refresh) a confirmation token for `user`+`chat`+`action`.
 * @returns {string} token
 */
export function createConfirmation({ user, chat, action, stage = 1, data = {}, ttlMs = DEFAULT_TTL_MS }) {
  // Drop any prior confirmation for the same triple so a fresh start supersedes it.
  for (const [token, entry] of confirmations) {
    if (key(entry.user, entry.chat, entry.action) === key(user, chat, action)) confirmations.delete(token);
  }
  const token = randomUUID();
  confirmations.set(token, { user, chat, action, stage, data, expiresAt: Date.now() + ttlMs });
  return token;
}

/**
 * Consume a confirmation, verifying it belongs to this user/chat/action and
 * has not expired. Returns the stored data, or null.
 */
export function consumeConfirmation(token, { user, chat, action }) {
  const entry = confirmations.get(token);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    confirmations.delete(token);
    return null;
  }
  if (entry.user !== user || entry.chat !== chat || entry.action !== action) return null;
  confirmations.delete(token);
  return entry.data;
}

/** True when a valid (non-expired, matching) confirmation exists for the triple. */
export function hasConfirmation(token, { user, chat, action }) {
  const entry = confirmations.get(token);
  if (!entry) return false;
  if (entry.expiresAt <= Date.now()) return false;
  return entry.user === user && entry.chat === chat && entry.action === action;
}

/** Cancel every confirmation for a triple (e.g. an aborted bulk action). */
export function cancelConfirmation({ user, chat, action }) {
  for (const [token, entry] of confirmations) {
    if (key(entry.user, entry.chat, entry.action) === key(user, chat, action)) confirmations.delete(token);
  }
}
