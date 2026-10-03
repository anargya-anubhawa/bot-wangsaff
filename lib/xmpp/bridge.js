/**
 * GX-ID — XMPP ↔ WhatsApp bridge logic
 *
 * Pure, dependency-light helpers that turn raw WhatsApp / XMPP messages into the
 * formatted text each side understands, plus the `Bridge` wiring that glues them
 * to a live socket and XMPP connection.
 *
 * Design rules (see the feature spec):
 *   • TEXT ONLY — media, stickers, polls, reactions, locations, … never relay.
 *   • Groups only — private chats never reach Minecraft.
 *   • Only configured bridge groups are used — never a broadcast to everyone.
 *   • No loops — bot-originated (`fromMe`) messages are ignored, and an XMPP
 *     echo of a message we just sent is dropped.
 *   • Rate limited (WhatsApp → Minecraft only).
 *   • Sanitised + truncated so Minecraft never receives raw WhatsApp markup or
 *     an over-long line.
 *
 * Everything here is unit-testable without a network: the `Bridge` accepts its
 * socket getter, bridge-state getter and XMPP sender as injected dependencies.
 */
import { logger as defaultLogger } from "../logger.js";

/* ─────────────────────────── text / media classification ─────────────────────────── */

/** Message types that count as a plain text chat (nothing else is relayed). */
export const TEXT_TYPES = new Set(["conversation", "extendedTextMessage"]);

/**
 * True only for a plain text message. `m.isMedia` (set by the serializer) plus an
 * explicit type allow-list keeps images, video, audio, voice notes, stickers,
 * documents, locations, contacts, polls, reactions and statuses out.
 */
export function isTextMessage(m) {
  if (!m) return false;
  if (m.isMedia) return false;
  return TEXT_TYPES.has(m.type);
}

/* ─────────────────────────── sanitisation & limits ─────────────────────────── */

/**
 * Reduce a WhatsApp body to plain text suitable for Minecraft chat:
 *   • drop zero-width / bidi control characters
 *   • unwrap ```code``` and `inline code` (keep the inner text)
 *   • strip WhatsApp emphasis markers (*bold* _italic_ ~strike~)
 *   • collapse every run of whitespace to a single space (Minecraft chat is one line)
 */
export function sanitizeWhatsAppText(text) {
  if (text === undefined || text === null) return "";
  let out = String(text);
  out = out.replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, "");
  out = out.replace(/```([\s\S]*?)```/g, "$1").replace(/`([^`]*)`/g, "$1");
  out = out.replace(/[*_~]/g, "");
  out = out.replace(/\s+/g, " ").trim();
  return out;
}

/** Truncate `text` to at most `max` characters (ellipsis counts toward `max`). */
export function truncate(text, max) {
  const value = String(text ?? "");
  if (!max || max <= 0 || value.length <= max) return value;
  const ellipsis = "…";
  const keep = Math.max(0, max - ellipsis.length);
  return value.slice(0, keep).trimEnd() + ellipsis;
}

/* ─────────────────────────── formatting ─────────────────────────── */

/**
 * Minecraft → WhatsApp.
 *
 *   ⛏️ Minecraft
 *
 *   Steve: Halo guys
 */
export function formatMinecraftToWhatsApp(name, text, format = {}) {
  const header = format.incomingHeader || "⛏️ Minecraft";
  const who = String(name || "Minecraft").trim();
  const body = String(text ?? "").trim();
  return `${header}\n\n${who}: ${body}`;
}

/**
 * WhatsApp → Minecraft.
 *
 *   [WA] Anargya: Halo Steve!
 */
export function formatWhatsAppToMinecraft(name, text, format = {}) {
  const prefix = format.outgoingPrefix ?? "[WA]";
  const who = String(name || "User").trim();
  const body = String(text ?? "").trim();
  return `${prefix} ${who}: ${body}`.trim();
}

/* ─────────────────────────── inbound XMPP parsing ─────────────────────────── */

/**
 * Extract `{ name, text }` from an incoming XMPP chat message.
 *
 * Handles the three shapes EssentialsXMPP/Prosody produce:
 *   • `<Steve> Halo guys`      → name "Steve", text "Halo guys"
 *   • `Steve: Halo guys`       → name "Steve", text "Halo guys"
 *   • `Halo guys` (MUC)        → name from the JID resource (the player nick)
 *
 * @param {{from?: string, type?: string, body?: string}} msg
 * @returns {{name: string, text: string, jid: string, resource: string}}
 */
export function parseMinecraftMessage(msg = {}) {
  const from = String(msg.from || "");
  const [jidPart, resource = ""] = from.split("/");
  const localpart = jidPart.split("@")[0] || "";
  const body = String(msg.body ?? "").trim();

  let name = "";
  let text = body;

  const angle = body.match(/^<([^>]{1,32})>\s*([\s\S]*)$/);
  const colon = body.match(/^([A-Za-z0-9_]{1,16})[:>]\s+([\s\S]*)$/);

  if (angle) {
    name = angle[1].trim();
    text = angle[2].trim();
  } else if (colon) {
    name = colon[1].trim();
    text = colon[2].trim();
  } else if (resource) {
    name = resource;
  } else {
    name = localpart || "Minecraft";
  }

  return { name: name || "Minecraft", text, jid: jidPart, resource };
}

/* ─────────────────────────── rate limiting ─────────────────────────── */

/**
 * Sliding-window rate limiter. Used ONLY for WhatsApp → Minecraft so a spammy
 * group cannot flood the server; Minecraft → WhatsApp is never throttled.
 */
export class RateLimiter {
  constructor({ max = 3, windowMs = 5000 } = {}) {
    this.max = max;
    this.windowMs = windowMs;
    /** @type {Map<string, number[]>} */
    this.hits = new Map();
  }

  /**
   * Record a hit for `key`.
   * @returns {{allowed: boolean, retryAfterMs: number}}
   */
  check(key, now = Date.now()) {
    if (!this.max || this.max <= 0) return { allowed: true, retryAfterMs: 0 };
    const k = String(key || "anonymous");
    const cutoff = now - this.windowMs;
    const list = (this.hits.get(k) || []).filter((t) => t > cutoff);

    if (list.length >= this.max) {
      const oldest = list[0];
      this.hits.set(k, list);
      return { allowed: false, retryAfterMs: Math.max(0, this.windowMs - (now - oldest)) };
    }

    list.push(now);
    this.hits.set(k, list);
    return { allowed: true, retryAfterMs: 0 };
  }

  reset(key) {
    if (key === undefined) this.hits.clear();
    else this.hits.delete(String(key));
  }
}

/* ─────────────────────────── relay decision (WhatsApp → Minecraft) ─────────────────────────── */

/**
 * Decide whether an incoming WhatsApp message should be relayed to Minecraft.
 *
 * @param {object} m              serialized WhatsApp message
 * @param {object} opts
 * @param {boolean} opts.enabled  bridge master switch
 * @param {string[]} opts.groups  configured bridge group JIDs
 * @param {object} [opts.config]  xmpp config (for `blockPrefixes`)
 * @returns {{relay: boolean, reason: string, text: string}}
 */
export function shouldRelayWhatsApp(m, { enabled, groups = [], config = {} } = {}) {
  const no = (reason) => ({ relay: false, reason, text: "" });

  if (!enabled) return no("bridge disabled");
  if (!m) return no("no message");
  if (!m.isGroup) return no("not a group message");
  if (m.fromMe) return no("bot message");
  if (m.isCommand) return no("command");
  if (!isTextMessage(m)) return no("not text");

  const blocked = config.blockPrefixes || ["/"];
  const body = String(m.body || "").trim();
  if (!body) return no("empty");
  if (blocked.some((p) => p && body.startsWith(p))) return no("blocked prefix");

  const groupsSet = new Set((groups || []).map(String));
  if (!groupsSet.has(String(m.chat))) return no("group not in bridge");

  return { relay: true, reason: "ok", text: body };
}

/* ─────────────────────────── the wired bridge ─────────────────────────── */

/**
 * Glue the pure helpers to a live socket + XMPP sender.
 *
 * @param {object} deps
 * @param {object}   deps.config          xmpp config (config/xmpp.js)
 * @param {Function} deps.getSocket       () => WhatsApp socket | null
 * @param {Function} deps.getBridgeState  () => { enabled, groups }
 * @param {Function} deps.sendXmpp        async (text) => void  (throws on failure)
 * @param {object}   [deps.logger]
 */
export function createBridge({ config, getSocket, getBridgeState, sendXmpp, logger = defaultLogger } = {}) {
  const rateLimiter = new RateLimiter(config?.rateLimit);
  /** Normalised bodies we recently pushed to Minecraft, to drop the server echo. */
  const recentOutgoing = new Map();
  const ECHO_TTL_MS = 20000;

  /** Serialise XMPP sends so concurrent chats never interleave on the wire. */
  let sendChain = Promise.resolve();

  function rememberOutgoing(text) {
    const key = String(text || "").trim();
    if (!key) return;
    recentOutgoing.set(key, Date.now());
    // opportunistic prune
    const cutoff = Date.now() - ECHO_TTL_MS;
    for (const [k, at] of recentOutgoing) if (at < cutoff) recentOutgoing.delete(k);
  }

  function isEcho(...candidates) {
    const cutoff = Date.now() - ECHO_TTL_MS;
    for (const c of candidates) {
      const key = String(c || "").trim();
      if (!key) continue;
      const at = recentOutgoing.get(key);
      if (at && at > cutoff) return true;
    }
    return false;
  }

  /**
   * WhatsApp → Minecraft. Called from the message pipeline for every
   * non-command message. Returns `true` when the message was relayed.
   */
  async function relayWhatsAppToMinecraft(m) {
    const state = getBridgeState?.() || {};
    const decision = shouldRelayWhatsApp(m, {
      enabled: state.enabled,
      groups: state.groups,
      config,
    });
    if (!decision.relay) return false;

    const limit = rateLimiter.check(m.sender || m.chat);
    if (!limit.allowed) {
      const seconds = Math.ceil(limit.retryAfterMs / 1000) || 1;
      logger.warn(`[WA → XMPP] rate limited (${m.pushName || m.sender})`);
      await m.reply?.(`⚠️ *Terlalu banyak pesan.* Tunggu ${seconds} detik sebelum mengirim lagi.`).catch(() => {});
      return false;
    }

    const name = m.pushName || m.senderNumber || "User";
    const clean = sanitizeWhatsAppText(decision.text);
    if (!clean) return false;

    const formatted = truncate(
      formatWhatsAppToMinecraft(name, clean, config?.format),
      config?.maxMessageLength,
    );

    try {
      // Serialise sends: each send waits for the previous one, but its own
      // failure must still propagate here (the chain keeps a swallowed copy so
      // the next send is never blocked by an earlier failure).
      const run = sendChain.then(() => sendXmpp(formatted));
      sendChain = run.catch(() => {});
      await run;
      rememberOutgoing(formatted);
      // also remember the bare text so an echo that only keeps the body is caught
      rememberOutgoing(clean);
      logger.info(`[WA → XMPP] ${name}: ${clean}`);
      return true;
    } catch (error) {
      logger.error(`[XMPP] Failed to send message: ${error?.message || error}`);
      await m.reply?.("⚠️ *Minecraft bridge sedang tidak terhubung.*").catch(() => {});
      return false;
    }
  }

  /**
   * Minecraft → WhatsApp. Called for every incoming XMPP chat stanza. Broadcasts
   * to every configured bridge group (and only those). Returns the number of
   * groups the message was delivered to.
   */
  async function handleMinecraftMessage(msg) {
    const state = getBridgeState?.() || {};
    if (!state.enabled) return 0;

    const parsed = parseMinecraftMessage(msg);
    const rawBody = String(msg.body ?? "").trim();
    if (!rawBody) return 0;

    /* loop guard: ignore the server echoing back something we just sent, and our
       own MUC nickname. */
    if (parsed.name === (config?.nick || "WhatsApp")) return 0;
    if (isEcho(rawBody, parsed.text)) {
      logger.debug?.(`[XMPP → WA] ignored echo from ${parsed.name}`);
      return 0;
    }

    const sock = getSocket?.();
    if (!sock) {
      logger.warn("[XMPP → WA] WhatsApp socket unavailable — dropping Minecraft chat");
      return 0;
    }

    const groups = (state.groups || []).map(String);
    if (!groups.length) return 0;

    const text = truncate(
      formatMinecraftToWhatsApp(parsed.name, parsed.text, config?.format),
      // WhatsApp itself allows much longer text than Minecraft, so only the
      // Minecraft-side limit is relevant here — no truncation for incoming.
      config?.maxMessageLength * 8,
    );

    logger.info(`[XMPP → WA] ${parsed.name}: ${parsed.text}`);

    let delivered = 0;
    for (const group of groups) {
      try {
        await sock.sendMessage(group, { text });
        delivered += 1;
      } catch (error) {
        logger.error(`[XMPP → WA] failed to send to ${group}: ${error?.message || error}`);
      }
    }
    return delivered;
  }

  return {
    relayWhatsAppToMinecraft,
    handleMinecraftMessage,
    rateLimiter,
    isEcho,
    rememberOutgoing,
  };
}
