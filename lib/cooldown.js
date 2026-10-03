/**
 * GX-ID — group-scoped cooldown service
 *
 * Applies the per-group `cooldown` setting (configured via `commandcd`) to
 * non owner/whitelist/admin users, and the per-group filter cooldown
 * (`filtercd`). Both share one implementation, keyed by
 * `groupJid + user + command`, so a filter firing never collides with a real
 * command's cooldown.
 *
 * A cooldown of 86400 (24h) is treated specially: it resets at 00:00 in the
 * configured timezone rather than exactly 24h after last use.
 */
import { getDatabase } from "./database.js";
import { getConfiguredTimezone, getCurrentTimeParts, secondsUntilNextMidnight } from "./settings.js";

const DAY_SECONDS = 24 * 60 * 60;

/** Reserved pseudo-command key for the filter feature (no real command uses `__`). */
export const FILTER_COOLDOWN_KEY = "__filter__";

function key(groupJid, number, command) {
  return `${groupJid}|${number}|${command}`;
}

function getLastUsed(groupJid, number, command) {
  try {
    const map = getDatabase().setting("groupCooldowns") || {};
    return map[key(groupJid, number, command)] ?? null;
  } catch {
    return null;
  }
}

function markUsed(groupJid, number, command) {
  try {
    const db = getDatabase();
    const map = db.setting("groupCooldowns") || {};
    map[key(groupJid, number, command)] = Date.now();
    db.setting("groupCooldowns", map);
  } catch {
    /* database not ready */
  }
}

/**
 * @returns {{allowed:boolean, remainingSeconds?:number}}
 */
export function checkGroupCooldown(groupJid, number, command, cooldownSeconds) {
  if (!cooldownSeconds || cooldownSeconds <= 0) return { allowed: true };

  const lastUsed = getLastUsed(groupJid, number, command);
  if (lastUsed === null) return { allowed: true };

  if (cooldownSeconds === DAY_SECONDS) {
    const timezone = getConfiguredTimezone();
    const lastUsedDay = getCurrentTimeParts(timezone, new Date(lastUsed)).ddmmyyyy;
    const today = getCurrentTimeParts(timezone).ddmmyyyy;
    if (lastUsedDay !== today) return { allowed: true };
    return { allowed: false, remainingSeconds: secondsUntilNextMidnight(timezone) };
  }

  const elapsed = (Date.now() - lastUsed) / 1000;
  if (elapsed >= cooldownSeconds) return { allowed: true };
  return { allowed: false, remainingSeconds: Math.ceil(cooldownSeconds - elapsed) };
}

export function applyGroupCooldown(groupJid, number, command) {
  markUsed(groupJid, number, command);
}

/** Reads a group's configured command cooldown (seconds). Default 0 (disabled). */
export function getGroupCooldown(groupJid) {
  try {
    return Number(getDatabase().getGroup(groupJid)?.cooldownSeconds || 0);
  } catch {
    return 0;
  }
}

export function setGroupCooldown(groupJid, seconds) {
  try {
    getDatabase().setGroup(groupJid, { cooldownSeconds: Number(seconds) || 0 });
  } catch {
    /* ignore */
  }
}

/** Reads a group's configured filter cooldown (seconds). Default 120. */
export function getFilterCooldown(groupJid) {
  try {
    const value = getDatabase().getGroup(groupJid)?.filterCooldownSeconds;
    return value === undefined || value === null ? 120 : Number(value);
  } catch {
    return 120;
  }
}

export function setFilterCooldown(groupJid, seconds) {
  try {
    getDatabase().setGroup(groupJid, { filterCooldownSeconds: Number(seconds) || 0 });
  } catch {
    /* ignore */
  }
}
