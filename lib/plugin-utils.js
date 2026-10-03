/**
 * GX-ID — plugin helper utilities
 *
 * Small, dependency-free helpers shared by the group/security/filter/config
 * plugins so validation and messaging stay consistent. These are intentionally
 * thin — anything non-trivial lives in a dedicated `lib/` service.
 */
import { getDatabase } from "./database.js";
import { resolveTarget, findParticipant, numberFromJid } from "./group-utils.js";
import { isBotAdminCached } from "./group-cache.js";

/** Parse a boolean argument ("on"/"off"/"enable"/"disable"/"1"/"0"). */
export function parseToggle(arg) {
  const value = String(arg || "").trim().toLowerCase();
  if (["on", "enable", "enabled", "true", "1", "aktif", "nyala"].includes(value)) return true;
  if (["off", "disable", "disabled", "false", "0", "mati", "nonaktif"].includes(value)) return false;
  return null;
}

/** Render an on/off toggle state. */
export function toggleLabel(state) {
  return state ? "✅ *ON*" : "❌ *OFF*";
}

/**
 * Resolve a single target participant JID from a reply/mention/number.
 * Returns `{ jid, participant }` or null.
 */
export function resolveSingleTarget(m) {
  const target = resolveTarget(m);
  if (!target) return null;
  const participant = findParticipant(m.groupMetadata?.participants || [], target);
  const jid = participant?.jid || participant?.id || target;
  return { jid, participant, number: numberFromJid(jid) };
}

/** Ensure the bot is a group admin before a mutating action; returns boolean. */
export async function ensureBotAdmin(m, sock) {
  if (m.isBotAdmin) return true;
  try {
    return await isBotAdminCached(sock, m.chat);
  } catch {
    return false;
  }
}

/** Standard "bot must be admin" reply. */
export const BOT_NOT_ADMIN = "🤖 *Bot harus menjadi admin* untuk melakukan ini.";

/** Standard "group only" reply. */
export const GROUP_ONLY = "❌ Perintah ini hanya dapat digunakan di dalam grup.";

/**
 * Split a command's argument text into its first argument and the remainder,
 * honouring a leading quoted string so arguments that contain spaces survive.
 *
 * `"re:^halo dunia$" Hai!`  → { first: "re:^halo dunia$", rest: "Hai!" }
 * `halo Halo juga!`         → { first: "halo",           rest: "Halo juga!" }
 * `"halo dunia"`            → { first: "halo dunia",     rest: "" }
 *
 * Used by the filter commands so a trigger (literal phrase OR `re:` regex) may
 * contain spaces when wrapped in single/double quotes.
 */
export function splitQuotedArg(text) {
  const value = String(text || "").trim();
  if (!value) return { first: "", rest: "" };
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    const end = value.indexOf(quote, 1);
    if (end > 1) return { first: value.slice(1, end).trim(), rest: value.slice(end + 1).trim() };
    return { first: value.slice(1).trim(), rest: "" };
  }
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(value);
  return { first: match ? match[1] : value, rest: match?.[2] ? match[2].trim() : "" };
}

/** Strip a single pair of matching surrounding quotes from `text`. */
export function stripQuotes(text) {
  const value = String(text || "").trim();
  if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) {
    return value.slice(1, -1).trim();
  }
  return value;
}

/**
 * Read a per-group settings object merged with sane defaults.
 */
export function groupSettings(m) {
  const db = getDatabase();
  const group = db.getGroup(m.chat) || {};
  return {
    antilink: !!group.antilink,
    antivirtex: !!group.antivirtex,
    antinsfw: !!group.antinsfw,
    allowAdminCommands: group.allowAdminCommands !== false,
    allowSaveNote: group.allowSaveNote || "admin",
    cooldownSeconds: Number(group.cooldownSeconds || 0),
    filterCooldownSeconds: group.filterCooldownSeconds === undefined ? 120 : Number(group.filterCooldownSeconds),
    prefix: group.prefix || null,
    disabledCommands: group.disabledCommands || [],
  };
}

/** Persist a partial per-group settings update. */
export function updateGroupSettings(m, patch) {
  const db = getDatabase();
  db.setGroup(m.chat, patch);
}
