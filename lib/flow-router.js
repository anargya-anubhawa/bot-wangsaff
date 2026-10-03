/**
 * GX-ID — Native Flow action router
 *
 * Native-flow row ids are namespaced strings such as:
 *
 *   altheora:file:sop:sop-akademik
 *   altheora:cat:sop:1
 *   altheora:cats:0
 *
 * When a user taps a row, WhatsApp returns an `interactiveResponseMessage`
 * whose `paramsJson.id` is that string. `lib/serialize.js` extracts it into
 * `m.body`, and the message pipeline hands it to `handleFlowAction()` BEFORE
 * command parsing. Each feature registers a handler for its namespace, so
 * plugins never have to understand the whole flow structure — they only see
 * `{ action, args }` for their own namespace.
 */
import { logger } from "./logger.js";

/** namespace → handler(m, ctx, { action, args }) */
const routes = new Map();

/** Namespaces are `[a-z0-9_-]` only. */
const NAMESPACE_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * Register (or replace) the handler for a flow namespace.
 * @param {string} namespace
 * @param {(m:object, ctx:object, action:{action:string,args:string[],raw:string}) => Promise<boolean|void>} handler
 */
export function registerFlowRoute(namespace, handler) {
  const ns = String(namespace || "").toLowerCase();
  if (!NAMESPACE_RE.test(ns) || typeof handler !== "function") return false;
  routes.set(ns, handler);
  return true;
}

/**
 * Parse a flow id into its parts. Returns `null` when the body is not a
 * namespaced flow id (so ordinary commands are left untouched).
 *
 * @param {string} body
 * @returns {{namespace:string, action:string, args:string[], raw:string}|null}
 */
export function parseFlowAction(body) {
  if (!body || typeof body !== "string") return null;
  const trimmed = body.trim();
  if (!trimmed || trimmed.length > 256) return null;
  if (!trimmed.includes(":")) return null;
  // Reject anything that could be a path or contain whitespace/newlines.
  if (/[\s/\\]/.test(trimmed)) return null;

  const parts = trimmed.split(":").filter(Boolean);
  if (parts.length < 2) return null;
  const namespace = parts[0].toLowerCase();
  if (!NAMESPACE_RE.test(namespace)) return null;
  if (!routes.has(namespace)) return null;

  const action = (parts[1] || "").toLowerCase();
  const args = parts.slice(2);
  return { namespace, action, args, raw: trimmed };
}

/**
 * Dispatch a flow action to its namespace handler.
 * @returns {Promise<boolean>} `true` when a handler consumed the message.
 */
export async function handleFlowAction(m, ctx) {
  const parsed = parseFlowAction(m?.body);
  if (!parsed) return false;

  const handler = routes.get(parsed.namespace);
  if (!handler) return false;

  try {
    const result = await handler(m, ctx, parsed);
    return result !== false;
  } catch (error) {
    logger.error(`[FLOW] route "${parsed.namespace}" failed: ${error.message}`);
    try {
      await m.reply?.("❌ *Gagal memproses pilihan.*\n\n> Silakan coba lagi.");
    } catch {
      /* ignore */
    }
    return true;
  }
}
