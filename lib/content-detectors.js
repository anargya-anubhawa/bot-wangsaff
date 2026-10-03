/**
 * GX-ID — content detectors
 *
 * Heuristics for `antilink`, `antivirtex`, the group blacklist and the filter
 * feature. Deliberately conservative/tunable — false negatives are far less
 * disruptive than false positives (deleting an innocent message). Ported from
 * the reference project's `utils/contentDetectors.ts` and adapted to GX-ID.
 */

/** Matches explicit URLs, WhatsApp's own link formats, and common bare domains. */
const LINK_REGEX =
  /(https?:\/\/\S+)|(\bwa\.me\/\S+)|(\bchat\.whatsapp\.com\/\S+)|(\b[a-z0-9-]+\.(com|net|org|co|id|io|me|link|xyz|info|biz|ly|gg|to|dev|app)\b\S*)/i;

export function containsLink(text) {
  return LINK_REGEX.test(String(text || ""));
}

/* ─────────────────────────── virtex heuristics ─────────────────────────── */

const LONGEST_TOKEN_THRESHOLD = 250; // a single "word" longer than this is suspicious
const TOTAL_LENGTH_THRESHOLD = 3000; // an extremely long message overall
const COMBINING_MARK_RATIO_THRESHOLD = 0.3; // >30% combining/bidi-control marks
const COMBINING_MARK_MIN_LENGTH = 20;

const COMBINING_OR_BIDI_REGEX =
  /[\u0300-\u036F\u1AB0-\u1AFF\u1DC0-\u1DFF\u20D0-\u20FF\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

export function isVirtexLike(text) {
  const value = String(text || "");
  if (value.length > TOTAL_LENGTH_THRESHOLD) return true;

  const longestToken = value.split(/\s+/).reduce((max, token) => Math.max(max, token.length), 0);
  if (longestToken > LONGEST_TOKEN_THRESHOLD) return true;

  if (value.length >= COMBINING_MARK_MIN_LENGTH) {
    const combiningCount = (value.match(COMBINING_OR_BIDI_REGEX) || []).length;
    if (combiningCount / value.length > COMBINING_MARK_RATIO_THRESHOLD) return true;
  }
  return false;
}

/* ─────────────────────────── entry matching ─────────────────────────── */

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Prefix marking an entry as an opt-in regex instead of a literal value. */
export const REGEX_PREFIX = "re:";
const REGEX_PREFIX_RE = /^re:/i;

export function isRegexEntry(entry) {
  return REGEX_PREFIX_RE.test(String(entry || ""));
}

export function regexSource(entry) {
  return String(entry || "").slice(REGEX_PREFIX.length).trim();
}

/** Canonical storage form: literals lowercased, regex sources kept verbatim. */
export function normalizeEntry(entry) {
  const value = String(entry ?? "").trim();
  if (isRegexEntry(value)) return REGEX_PREFIX + regexSource(value);
  return value.toLowerCase();
}

/** Compiles a `re:` entry as an unanchored case-insensitive regex, or null. */
export function compileRegexEntry(entry) {
  if (!isRegexEntry(entry)) return null;
  const source = regexSource(entry);
  if (!source) return null;
  try {
    return new RegExp(source, "i");
  } catch {
    return null;
  }
}

/** Validates a candidate entry. Returns a user-facing error string, or null. */
export function validateEntry(entry) {
  if (!isRegexEntry(entry)) return null;
  const source = regexSource(entry);
  if (!source) return 'Pola regex kosong setelah "re:".';
  try {
    new RegExp(source, "i");
    return null;
  } catch (err) {
    return `Pola regex tidak valid: ${err.message}`;
  }
}

/** Word-boundary matcher (blacklist rule). */
export function matchesWordEntry(text, entry) {
  if (isRegexEntry(entry)) {
    const pattern = compileRegexEntry(entry);
    return pattern ? pattern.test(text) : false;
  }
  return new RegExp(`\\b${escapeRegExp(entry)}\\b`, "i").test(text);
}

/** Exact matcher (filter rule): the whole message must equal the trigger. */
export function matchesExactEntry(text, entry) {
  const trimmed = String(text || "").trim();
  if (isRegexEntry(entry)) {
    const pattern = compileRegexEntry(entry);
    return pattern ? pattern.test(trimmed) : false;
  }
  return trimmed.toLowerCase() === entry;
}

/** Returns the first blacklist entry matching `text`, or null. */
export function findBlacklistMatch(text, entries) {
  for (const entry of entries || []) {
    if (matchesWordEntry(text, entry)) return entry;
  }
  return null;
}

/** Returns the first filter trigger matching `text`, or null. */
export function findFilterMatch(text, triggers) {
  for (const trigger of triggers || []) {
    if (matchesExactEntry(text, trigger)) return trigger;
  }
  return null;
}
