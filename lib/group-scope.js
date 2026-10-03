/**
 * GX-ID — feature-scoped group sharing
 *
 * A `.link <feature> <a> <b>` link does NOT copy data between groups: it makes
 * them share one *scope id*. Notes / filters / blacklists are stored keyed by
 * that scope id, so linked groups read and write the same records with no
 * duplication.
 *
 * The scope id defaults to the group's own JID, so an unlinked group behaves
 * exactly as before (its scope is itself).
 */
import { getDatabase } from "./database.js";

export const SCOPE_FEATURES = ["notes", "filters", "blacklist", "general"];

export function isScopeFeature(value) {
  return SCOPE_FEATURES.includes(String(value || "").toLowerCase());
}

/* ─────────────────────────── global scope ─────────────────────────── */

/**
 * A reserved scope id that every group reads from. Data written here (with the
 * `global` keyword, e.g. `.addnote global rules …`) is visible in *all*
 * registered groups without being duplicated. A group's own scope always wins
 * over the global scope for the same key.
 */
export const GLOBAL_SCOPE = "__global__";

/** The keyword a user types to address the global scope. */
export const GLOBAL_KEYWORD = "global";

/** True when a raw token addresses the global scope (reserved keyword). */
export function isGlobalTarget(token) {
  return String(token || "").trim().toLowerCase() === GLOBAL_KEYWORD;
}

/** The global scope id (kept as a function so callers need no constant import). */
export function globalScopeId() {
  return GLOBAL_SCOPE;
}

/** Overlay `own` on top of `global` (own wins) — a small dedupe helper. */
function overlay(globalItems, ownItems, keyOf) {
  const map = new Map();
  for (const item of globalItems) map.set(keyOf(item), item);
  for (const item of ownItems) map.set(keyOf(item), item);
  return [...map.values()];
}

/** Every note visible to `jid`: its scope overlaid on the global scope. */
export function listEffectiveNotes(db, jid) {
  return overlay(db.listNotes(GLOBAL_SCOPE), db.listNotes(resolveScopeId("notes", jid)), (n) => n.name);
}

/** A single note visible to `jid` (own scope first, then global). */
export function getEffectiveNote(db, jid, name) {
  return db.getNote(resolveScopeId("notes", jid), name) || db.getNote(GLOBAL_SCOPE, name);
}

/** Every filter visible to `jid`: its scope overlaid on the global scope. */
export function listEffectiveFilters(db, jid) {
  return overlay(db.listFilters(GLOBAL_SCOPE), db.listFilters(resolveScopeId("filters", jid)), (f) => f.trigger);
}

/** Every blacklist entry visible to `jid`: its scope overlaid on global. */
export function listEffectiveBlacklist(db, jid) {
  return overlay(db.listBlacklist(GLOBAL_SCOPE), db.listBlacklist(resolveScopeId("blacklist", jid)), (e) => e.entry);
}

/**
 * The storage scope a feature should use for `jid`. Returns the shared scope
 * id when the group is linked for that feature, otherwise `jid` itself.
 */
export function resolveScopeId(feature, jid) {
  if (!jid) return jid;
  try {
    const db = getDatabase();
    const scope = db.findScopeFor(feature, jid);
    return scope ? scope.id : jid;
  } catch {
    return jid;
  }
}

/** Every group that shares `feature` with `jid` (including `jid` itself). */
export function getScopeMembers(feature, jid) {
  if (!jid) return [];
  try {
    const db = getDatabase();
    const scope = db.findScopeFor(feature, jid);
    return scope ? [...scope.groups] : [jid];
  } catch {
    return [jid];
  }
}

/** True when `a` and `b` share the given feature scope. */
export function areLinked(feature, aJid, bJid) {
  if (!aJid || !bJid || aJid === bJid) return false;
  try {
    const scope = getDatabase().findScopeFor(feature, aJid);
    return !!scope && scope.groups.includes(bJid);
  } catch {
    return false;
  }
}
