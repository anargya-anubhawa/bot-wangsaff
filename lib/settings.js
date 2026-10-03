/**
 * GX-ID — runtime settings service
 *
 * A thin, typed façade over the `settings` collection for the global,
 * non-per-group knobs configured by the bot-config commands (bulk delay,
 * presence simulation, quote/revoke limits, timezone, animsticker options).
 * Everything is persisted through the database, so a restart keeps the values.
 */
import { getDatabase } from "./database.js";

function db() {
  return getDatabase();
}

function get(key, fallback) {
  try {
    const value = db().setting(key);
    return value === undefined || value === null ? fallback : value;
  } catch {
    return fallback;
  }
}

function set(key, value) {
  try {
    db().setting(key, value);
  } catch {
    /* database not ready */
  }
}

/* ─────────────────────────── bulk action delay ─────────────────────────── */

export const DEFAULT_BULK_MIN_MS = 500;
export const DEFAULT_BULK_MAX_MS = 1500;

export function getBulkActionDelayRange() {
  const min = Number(get("bulkDelayMin", DEFAULT_BULK_MIN_MS));
  const max = Number(get("bulkDelayMax", DEFAULT_BULK_MAX_MS));
  return [Number.isFinite(min) ? min : DEFAULT_BULK_MIN_MS, Number.isFinite(max) ? max : DEFAULT_BULK_MAX_MS];
}

export function setBulkActionDelayRange(min, max) {
  set("bulkDelayMin", String(min));
  set("bulkDelayMax", String(max));
}

/* ─────────────────────────── presence simulation ─────────────────────────── */

export const DEFAULT_PRESENCE_MIN_MS = 600;
export const DEFAULT_PRESENCE_MAX_MS = 1800;

export function isPresenceSimEnabled() {
  return get("presenceSim", true) !== false;
}

export function setPresenceSimEnabled(enabled) {
  set("presenceSim", !!enabled);
}

export function getPresenceDelayRange() {
  const min = Number(get("presenceDelayMin", DEFAULT_PRESENCE_MIN_MS));
  const max = Number(get("presenceDelayMax", DEFAULT_PRESENCE_MAX_MS));
  return [Number.isFinite(min) ? min : DEFAULT_PRESENCE_MIN_MS, Number.isFinite(max) ? max : DEFAULT_PRESENCE_MAX_MS];
}

export function setPresenceDelayRange(min, max) {
  set("presenceDelayMin", String(min));
  set("presenceDelayMax", String(max));
}

/* ─────────────────────────── quote limit ─────────────────────────── */

export const DEFAULT_QUOTE_MAX_CHARS = 100;
export const QUOTE_MAX_CHARS_CEILING = 200;

export function getQuoteMaxChars() {
  const value = Number(get("quoteMaxChars", DEFAULT_QUOTE_MAX_CHARS));
  return Number.isFinite(value) ? value : DEFAULT_QUOTE_MAX_CHARS;
}

export function setQuoteMaxChars(chars) {
  set("quoteMaxChars", String(chars));
}

/* ─────────────────────────── revoke limit ─────────────────────────── */

const MB = 1024 * 1024;
export const DEFAULT_REVOKE_MAX_BYTES = 5 * MB;
export const REVOKE_MAX_BYTES_CEILING = 50 * MB;

export function getRevokeMaxBytes() {
  const value = Number(get("revokeMaxBytes", DEFAULT_REVOKE_MAX_BYTES));
  return Number.isFinite(value) ? value : DEFAULT_REVOKE_MAX_BYTES;
}

export function setRevokeMaxBytes(bytes) {
  set("revokeMaxBytes", String(bytes));
}

/* ─────────────────────────── timezone ─────────────────────────── */

export const DEFAULT_TIMEZONE = "Asia/Jakarta";

export function getConfiguredTimezone() {
  return get("timezone", DEFAULT_TIMEZONE) || DEFAULT_TIMEZONE;
}

export function setConfiguredTimezone(timezone) {
  set("timezone", timezone);
}

/** True if `timezone` is an IANA name `Intl` actually recognises. */
export function isValidTimezone(timezone) {
  try {
    // eslint-disable-next-line no-new
    new Intl.DateTimeFormat("en-GB", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** Current time parts in the configured timezone: { hhmm, weekdayName, ddmmyyyy }. */
export function getCurrentTimeParts(timezone = getConfiguredTimezone(), date = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    hhmm: `${parts.hour}:${parts.minute}`,
    weekdayName: (parts.weekday || "").toLowerCase(),
    ddmmyyyy: `${parts.day}.${parts.month}.${parts.year}`,
  };
}

/** Seconds until the next local midnight in the given timezone. */
export function secondsUntilNextMidnight(timezone = getConfiguredTimezone()) {
  const { hhmm } = getCurrentTimeParts(timezone);
  const [h, m] = hhmm.split(":").map(Number);
  return (24 * 60 - (h * 60 + m)) * 60;
}

/* ─────────────────────────── animsticker defaults ─────────────────────────── */

export function getAnimStickerOptions() {
  return get("animstickerOptions", "");
}

export function setAnimStickerOptions(options) {
  set("animstickerOptions", String(options || ""));
}

/* ─────────────────────────── feature scopes (registered | public) ─────────────────────────── */

export const SCOPE_REGISTERED = "registered";
export const SCOPE_PUBLIC = "public";

/** Normalise any input to one of the two supported scopes. */
export function normalizeScope(value) {
  return String(value || "").trim().toLowerCase() === SCOPE_PUBLIC ? SCOPE_PUBLIC : SCOPE_REGISTERED;
}

/**
 * Scope of the deleted-message log (`.del`, antilink, antivirtex, antinsfw,
 * blacklist, revoke):
 *   "registered" (default) — only registered groups produce log events
 *   "public"               — every group produces log events (non-registered
 *                            groups forward to the global default panel)
 */
export function getLogScope() {
  return normalizeScope(get("logScope", SCOPE_REGISTERED));
}

export function setLogScope(scope) {
  set("logScope", normalizeScope(scope));
}

/**
 * Scope of the view-once reader (`.rvo`):
 *   "registered" (default) — `.rvo` only works inside registered groups and its
 *                            activity is recorded in the log
 *   "public"               — `.rvo` works in every group
 */
export function getRvoScope() {
  return normalizeScope(get("rvoScope", SCOPE_REGISTERED));
}

export function setRvoScope(scope) {
  set("rvoScope", normalizeScope(scope));
}

/** Global panel that receives public-mode logs from NON-registered groups. */
export function getDefaultLogPanel() {
  const value = get("defaultLogPanel", null);
  return value ? String(value) : null;
}

export function setDefaultLogPanel(jid) {
  set("defaultLogPanel", jid || null);
}
