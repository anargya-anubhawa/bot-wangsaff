/**
 * GX-ID — centralised access control
 *
 * Single source of truth for the four access tiers the bot recognises:
 *
 *   OWNER      — the bot owner (config owner/bot number, or a db owner entry)
 *   WHITELIST  — globally trusted numbers (`whitelist` collection)
 *   GROUP_ADMIN— a participant whose `admin` flag is set in group metadata
 *   USER       — everyone else
 *
 * Owner always bypasses the whitelist (never has to be added to it), and
 * group-admin privileges are only ever honoured inside a group. Plugins never
 * re-implement these checks — they declare a `permission` tier in their
 * `pluginConfig` and `lib/middleware.js` enforces it through `canUseCommand`.
 */
import config from "../config.js";
import { getDatabase } from "./database.js";

/** Digits-only normalisation shared by every access lookup. */
export function toNumber(value) {
  return String(value || "").split("@")[0].split(":")[0].replace(/[^0-9]/g, "");
}

/** OWNER: config owner/bot number, or an owner entry stored in the database. */
export function isOwner(jidOrNumber) {
  const number = toNumber(jidOrNumber);
  if (!number) return false;
  try {
    if (config.isOwner?.(number)) return true;
  } catch {
    /* config helper unavailable */
  }
  try {
    const db = getDatabase();
    const list = db.setting("ownerNumbers");
    if (Array.isArray(list) && list.some((o) => toNumber(o) === number)) return true;
  } catch {
    /* database not ready */
  }
  return false;
}

/** Whether the whitelist feature is active (`.whitelist on|off`). Defaults to on. */
export function isWhitelistEnabled() {
  try {
    const value = getDatabase().setting("whitelistEnabled");
    return value === undefined ? true : value !== false;
  } catch {
    return true;
  }
}

/** Turn the whitelist feature on/off globally. */
export function setWhitelistEnabled(enabled) {
  try {
    getDatabase().setting("whitelistEnabled", !!enabled);
  } catch {
    /* database not ready */
  }
}

/**
 * WHITELIST: a globally trusted number. Owner is always implicitly whitelisted.
 * Returns `false` whenever the feature is switched off (`.whitelist off`).
 */
export function isWhitelisted(jidOrNumber) {
  const number = toNumber(jidOrNumber);
  if (!number) return false;
  if (isOwner(number)) return true;
  if (!isWhitelistEnabled()) return false;
  try {
    return getDatabase().isWhitelisted(number);
  } catch {
    return false;
  }
}

/**
 * OWNER or WHITELIST (context-free).
 *
 * Prefer `isOwnerOrWhitelistedIn(m)` in message flows: the whitelist only grants
 * trust in private chat, so a group message must not use this bare helper.
 */
export function isOwnerOrWhitelisted(jidOrNumber) {
  return isOwner(jidOrNumber) || isWhitelisted(jidOrNumber);
}

/**
 * OWNER or WHITELIST, but the *whitelist* half only counts OUTSIDE a group.
 *
 * The whitelist is a private-chat (PC) privilege: inside a group a whitelisted
 * member is an ordinary member, so they are moderated, cooldowned and never
 * granted admin/owner tiers. The owner is unaffected — they keep their rights
 * everywhere. Honours the global `.whitelist off` toggle via `isWhitelisted`.
 */
export function isOwnerOrWhitelistedIn(m) {
  if (!m) return false;
  if (m.isOwner || m.fromMe) return true;
  if (isOwner(m.sender)) return true;
  if (m.isGroup) return false;
  return isWhitelisted(m.sender);
}

/**
 * GROUP_ADMIN: `m` must be a group message and the sender a participant whose
 * admin flag is set. Returns false in private chats and for non-members.
 */
export function isGroupAdmin(m) {
  if (!m || !m.isGroup) return false;
  if (m.isAdmin) return true;
  const number = toNumber(m.sender);
  return (m.groupMetadata?.participants || []).some((p) => {
    if (!p.admin) return false;
    return [p.jid, p.id, p.lid, p.phoneNumber]
      .filter(Boolean)
      .some((c) => toNumber(c) === number);
  });
}

/** True when the bot itself is an admin in the current group. */
export function botIsAdmin(m) {
  if (!m || !m.isGroup) return false;
  if (m.isBotAdmin) return true;
  const botNumber = toNumber(m.botJid || m.botNumber);
  return (m.groupMetadata?.participants || []).some((p) => {
    if (!p.admin) return false;
    return [p.jid, p.id, p.lid, p.phoneNumber]
      .filter(Boolean)
      .some((c) => toNumber(c) === botNumber);
  });
}

/**
 * Decide whether `m` may run a command whose `permission` tier is `tier`.
 *
 * Tiers:
 *   "all"     — everyone
 *   "owner"   — OWNER (whitelist only counts in a private chat)
 *   "admin"   — OWNER or GROUP_ADMIN (whitelist only counts in a private chat)
 *
 * @returns {boolean}
 */
export function canUseCommand(m, tier = "all") {
  if (!m) return false;
  if (m.fromMe) return true;
  if (tier === "all" || !tier) return true;
  if (isOwnerOrWhitelistedIn(m)) return true;
  if (tier === "admin") {
    if (!isGroupAdmin(m)) return false;
    /* group admins only get access when the group allows it (default on) */
    try {
      const group = getDatabase().getGroup(m.chat) || {};
      if (group.allowAdminCommands === false) return false;
    } catch {
      /* database not ready — default to allowing */
    }
    return true;
  }
  return false;
}

/** Human-readable label for a permission tier (used by `.help`). */
export function permissionLabel(tier = "all") {
  switch (tier) {
    case "owner":
      return "Owner / Whitelist";
    case "admin":
      return "Owner / Whitelist / Admin";
    default:
      return "Semua orang";
  }
}

/**
 * Remote group-management permission.
 *
 * A user may manage `groupJid` when they are the owner, or when they are an
 * admin of THAT group (not merely of the chat the command was typed in). The
 * global *whitelist* does NOT grant group-management rights — it is a
 * private-chat privilege only.
 *
 * @param {string} userId
 * @param {string} groupJid
 * @param {object} [sock] socket (used to fetch group metadata when available)
 * @returns {Promise<boolean>}
 */
export async function canManageGroup(userId, groupJid, sock = null) {
  if (!groupJid) return false;
  /* Managing a GROUP is a group privilege: the whitelist does not apply here
     (a whitelisted number is only trusted in private chat). */
  if (isOwner(userId)) return true;

  /* honour the target group's admin-command policy */
  try {
    const group = getDatabase().getGroup(groupJid) || {};
    if (group.allowAdminCommands === false) return false;
  } catch {
    /* database not ready — default to allowing */
  }

  if (!sock) return false;
  const number = toNumber(userId);
  if (!number) return false;

  try {
    const { isParticipantAdminCached } = await import("./group-cache.js");
    return await isParticipantAdminCached(sock, groupJid, number);
  } catch {
    return false;
  }
}


/* ─────────────────────────── group registration gate ─────────────────────────── */

/**
 * The registration gate is controlled by the `regcontrol` setting:
 *   "open"       (default) — every group may use the bot (legacy behaviour)
 *   "registered"           — only registered groups may use normal commands
 *
 * Owner/whitelist management commands are always exempt so a group can be
 * registered in the first place.
 */
export function getRegistrationMode() {
  try {
    return getDatabase().setting("regMode") || "open";
  } catch {
    return "open";
  }
}

export function isRegisteredGroup(jid) {
  try {
    return !!getDatabase().getRegistration(jid);
  } catch {
    return false;
  }
}

/**
 * Gate a normal command behind the registration mode. Returns `true` when the
 * command may proceed. `m` must be a group message.
 */
export function passesRegistrationGate(m) {
  if (!m?.isGroup) return true;
  if (getRegistrationMode() !== "registered") return true;
  if (isOwner(m.sender)) return true;
  return isRegisteredGroup(m.chat);
}
