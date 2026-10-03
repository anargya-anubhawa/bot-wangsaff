/**
 * GX-ID — XMPP bridge configuration (SINGLE SOURCE OF TRUTH)
 *
 * Everything the Minecraft ↔ WhatsApp bridge needs is defined here and read
 * from `.env` (see `.env.example`). Credentials are NEVER hardcoded anywhere
 * else in the codebase — import this module instead.
 *
 *   config/xmpp.js   ← connection + formatting + limits (this file)
 *   lib/xmpp/*.js    ← client / bridge / state (logic only)
 *   plugins/owner/xmpp.js ← the `.xmpp` admin command
 *
 * Bridge *groups* are seeded from `XMPP_BRIDGE_GROUPS` here, but at runtime they
 * live in the bot's existing database (settings key `xmppBridge`) so they can be
 * changed with `.xmpp setgroup` without a restart.
 */

/** Read a trimmed env var, treating an empty string as "unset". */
function env(key, fallback = undefined) {
  const value = process.env[key];
  return value === undefined || value === "" ? fallback : value;
}

/** Read a boolean env var (`1/true/yes/on` are truthy). */
function envBool(key, fallback = false) {
  const value = env(key);
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

/** Read an integer env var, falling back when it is not a finite number. */
function envInt(key, fallback) {
  const value = Number(env(key));
  return Number.isFinite(value) ? value : fallback;
}

/** Read a comma-separated list env var (values are kept verbatim, e.g. JIDs). */
function envList(key, fallback = []) {
  const value = env(key);
  if (!value) return fallback;
  return String(value)
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

const xmppConfig = {
  /** Master switch. Off by default so the bridge never affects the bot. */
  enabled: envBool("XMPP_ENABLED", false),

  /* ── Connection ── */
  host: env("XMPP_HOST", ""),
  port: envInt("XMPP_PORT", 5222),
  domain: env("XMPP_DOMAIN", "") || env("XMPP_HOST", ""),
  username: env("XMPP_USERNAME", "minecraft"),
  password: env("XMPP_PASSWORD", ""),
  resource: env("XMPP_RESOURCE", "gx-id"),

  /**
   * When `false` the client connects with plain TCP (`xmpp://`) and upgrades
   * with STARTTLS only if the server offers it — the common Prosody test setup.
   * When `true` it dials direct TLS (`xmpps://`).
   */
  requireTls: envBool("XMPP_REQUIRE_TLS", false),

  /* ── Routing (where Minecraft chat is sent / received) ── */
  /** Optional MUC room JID (e.g. `minecraft@conference.xmpp.anargya.my.id`). */
  room: env("XMPP_ROOM", ""),
  /** Nickname the bridge uses inside the MUC room. */
  nick: env("XMPP_NICK", "WhatsApp"),
  /** Direct recipient JID used when no `room` is configured. */
  to: env("XMPP_TO", ""),

  /* ── Bridge groups (seed — runtime list lives in the database) ── */
  bridgeGroups: envList("XMPP_BRIDGE_GROUPS", []),

  /* ── Message limits ── */
  /** Minecraft chat is short; longer WhatsApp text is truncated safely. */
  maxMessageLength: envInt("XMPP_MAX_LENGTH", 240),

  /** Prefixes that are never relayed (bot commands). The bot's own prefix is
   *  already excluded via `m.isCommand`; this catches the common `/` too. */
  blockPrefixes: envList("XMPP_BLOCK_PREFIXES", ["/"]),

  /* ── Rate limit (WhatsApp → Minecraft only) ── */
  rateLimit: {
    max: envInt("XMPP_RATE_MAX", 3),
    windowMs: envInt("XMPP_RATE_WINDOW_MS", 5000),
  },

  /* ── Reconnect backoff ── */
  reconnect: {
    minDelayMs: envInt("XMPP_RECONNECT_MIN_MS", 1000),
    maxDelayMs: envInt("XMPP_RECONNECT_MAX_MS", 30000),
  },

  /* ── Formatting ── */
  format: {
    /** Header line for a Minecraft → WhatsApp message. */
    incomingHeader: env("XMPP_IN_HEADER", "⛏️ Minecraft"),
    /** Prefix for a WhatsApp → Minecraft message. */
    outgoingPrefix: env("XMPP_OUT_PREFIX", "[WA]"),
  },
};

/** The `service` URI `@xmpp/client` should dial. */
export function getService(cfg = xmppConfig) {
  const scheme = cfg.requireTls ? "xmpps" : "xmpp";
  return `${scheme}://${cfg.host}:${cfg.port}`;
}

/** True when enough is configured to attempt a connection. */
export function isConfigured(cfg = xmppConfig) {
  return Boolean(cfg.host && cfg.username && cfg.password);
}

/** Bare account JID (`user@domain`) — never includes the password. */
export function getAccount(cfg = xmppConfig) {
  if (!cfg.username || !cfg.domain) return "";
  return `${cfg.username}@${cfg.domain}`;
}

export { xmppConfig };
export default xmppConfig;
