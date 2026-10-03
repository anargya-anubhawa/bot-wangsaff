/**
 * GX-ID — middleware
 *
 * Permission + mode + registration checks run before a plugin handler
 * executes. Permission decisions are delegated to `lib/access.js` so every
 * plugin shares one implementation.
 */
import config from "../config.js";
import { getDatabase } from "./database.js";
import { canUseCommand, passesRegistrationGate, isOwnerOrWhitelistedIn } from "./access.js";

export function levenshtein(a, b) {
  a = String(a || "");
  b = String(b || "");
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const cost = a[j - 1] === b[i - 1] ? 0 : 1;
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost);
    }
  }
  return matrix[b.length][a.length];
}

/**
 * Check whether a message may run the given plugin.
 *
 * Two plugin styles are supported:
 *   - New: `permission: "all" | "owner" | "admin"` (delegated to access.js).
 *   - Legacy: `isOwner` / `isPremium` / `isGroup` / `isPrivate` / `isAdmin` /
 *     `isBotAdmin` booleans (kept for the plugins that predate the tier system).
 *
 * @returns {{allowed: boolean, reason: string}}
 */
export function checkPermission(m, pluginConfig) {
  const cfg = pluginConfig || {};

  /* registration gate: only registered groups run normal commands when
     regMode === "registered"; registry/owner/whitelist commands are exempt. */
  if (cfg.permission !== "owner" && !isOwnerOrWhitelistedIn(m) && !passesRegistrationGate(m)) {
    return { allowed: false, reason: config.messages?.unregisteredGroup || "🔒 *Grup belum terdaftar.* Hubungi owner untuk mendaftarkan grup ini." };
  }

  /* context checks come first: a group-only command used in a private chat
     must say "group only", never "admin only" — the *where* is validated
     before the *who*. */
  if ((cfg.isGroup || cfg.permission === "admin") && !m.isGroup && cfg.permission !== "owner") {
    return { allowed: false, reason: config.messages?.groupOnly || "👥 Group only." };
  }

  if (cfg.isGroup && !m.isGroup) {
    return { allowed: false, reason: config.messages?.groupOnly || "👥 Group only." };
  }

  if (cfg.isPrivate && m.isGroup) {
    return { allowed: false, reason: config.messages?.privateOnly || "📱 Private only." };
  }

  /* runtime access override set via `.cmdaccess <command> <tier>` — takes
     precedence over the plugin's declared tier. */
  let tier = cfg.permission;
  try {
    const overrides = getDatabase().setting("commandAccess") || {};
    const override = overrides[String(cfg.name || "").toLowerCase()];
    if (override) tier = override;
  } catch {
    /* database not ready — fall back to the declared tier */
  }

  /* tier-based permission (preferred) */
  if (tier) {
    if (!canUseCommand(m, tier)) {
      const reason =
        tier === "owner"
          ? config.messages?.ownerOnly || "👑 Owner only."
          : config.messages?.adminOnly || "🛡️ Admin only.";
      return { allowed: false, reason };
    }
  }

  if (cfg.isOwner && !m.isOwner && !isOwnerOrWhitelistedIn(m)) {
    return { allowed: false, reason: config.messages?.ownerOnly || "👑 Owner only." };
  }

  if (cfg.isPremium && !m.isPremium && !m.isOwner) {
    return { allowed: false, reason: config.messages?.premiumOnly || "💎 Premium only." };
  }

  if (cfg.isAdmin && m.isGroup && !m.isAdmin && !m.isOwner && !isOwnerOrWhitelistedIn(m)) {
    return { allowed: false, reason: config.messages?.adminOnly || "🛡️ Admin only." };
  }

  if (cfg.isBotAdmin && m.isGroup && !m.isBotAdmin) {
    return { allowed: false, reason: config.messages?.botAdminOnly || "🤖 Bot must be admin." };
  }

  return { allowed: true, reason: "" };
}

/**
 * Check bot mode (public / self) and per-group overrides.
 * @returns {{allowed: boolean, reason?: string}}
 */
export function checkMode(m) {
  let db;
  try {
    db = getDatabase();
  } catch {
    db = null;
  }

  const mode = (db?.setting("botMode") || config.mode || "public").toLowerCase();

  // Group allow/deny lists always win for owner/bot.
  if (m.isGroup && db) {
    const selfGroups = db.setting("selfGroups") || [];
    if (selfGroups.includes(m.chat)) {
      if (m.fromMe || m.isOwner) return { allowed: true };
      return { allowed: false };
    }
    const publicGroups = db.setting("publicGroups") || [];
    if (publicGroups.includes(m.chat)) return { allowed: true };
  }

  if (mode === "self") {
    if (m.fromMe || m.isOwner) return { allowed: true };
    return { allowed: false, reason: config.messages?.selfMode || "🔒 The bot is in self mode." };
  }

  return { allowed: true };
}

/**
 * Whether a command is enabled, honouring `.cmd enable/disable` scopes.
 *
 * An entry may name a command, a category or one of the plugin's aliases. A
 * command is disabled when its name/category/alias is listed in:
 *   - the global disabled set            (everywhere)
 *   - the current group's disabled set   (inside that group)
 *   - the private-chat disabled set      (outside any group)
 */
function matchesDisabled(entry, pluginConfig) {
  const needle = String(entry || "").toLowerCase();
  if (!needle) return false;
  if (needle === String(pluginConfig?.name || "").toLowerCase()) return true;
  if (needle === String(pluginConfig?.category || "").toLowerCase()) return true;
  const aliases = Array.isArray(pluginConfig?.alias) ? pluginConfig.alias : [pluginConfig?.alias];
  return aliases.filter(Boolean).some((a) => String(a).toLowerCase() === needle);
}

export function checkCommandEnabled(m, pluginConfig) {
  let db;
  try {
    db = getDatabase();
  } catch {
    return { allowed: true };
  }
  if (!pluginConfig?.name) return { allowed: true };

  const globalDisabled = db.setting("disabledCommands") || [];
  if (globalDisabled.some((entry) => matchesDisabled(entry, pluginConfig))) {
    return { allowed: false, reason: `⚠️ Command \`${pluginConfig.name}\` dinonaktifkan secara global.` };
  }
  if (m.isGroup) {
    const group = db.getGroup(m.chat) || {};
    const groupDisabled = group.disabledCommands || [];
    if (groupDisabled.some((entry) => matchesDisabled(entry, pluginConfig))) {
      return { allowed: false, reason: `⚠️ Command \`${pluginConfig.name}\` dinonaktifkan di grup ini.` };
    }
  } else {
    const privateDisabled = db.setting("disabledPrivateCommands") || [];
    if (privateDisabled.some((entry) => matchesDisabled(entry, pluginConfig))) {
      return { allowed: false, reason: `⚠️ Command \`${pluginConfig.name}\` dinonaktifkan di private chat.` };
    }
  }
  return { allowed: true };
}
