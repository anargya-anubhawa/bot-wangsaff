/**
 * GX-ID — central group registry & alias resolver
 *
 * One source of truth for turning a user-typed target (`kelas-a`, `120363001@g.us`
 * or a bare internal id `120363001`) into the canonical **group JID** every
 * command stores and acts on.
 *
 * The alias is deliberately only a *resolver*: the database always keeps the
 * `groupId` as the real identifier, so aliases can be renamed or removed without
 * touching any configuration. A small version-stamped cache keeps lookups cheap
 * (the index is rebuilt only after a register / unregister / alias change).
 */
import { getDatabase } from "./database.js";
import { canManageGroup } from "./access.js";

/** Aliases: lowercase, no whitespace, safe characters only, 2–32 chars. */
const ALIAS_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;

export function normalizeAlias(value) {
  return String(value || "").trim().toLowerCase();
}

export function isValidAlias(value) {
  return ALIAS_RE.test(normalizeAlias(value));
}

/* ─────────────────────────── index cache ─────────────────────────── */

let cache = { version: -1, byAlias: new Map(), byId: new Map(), byJid: new Map() };

function buildIndex(db) {
  const version = typeof db.registryVersion === "function" ? db.registryVersion() : 0;
  if (cache.version === version) return cache;

  const byAlias = new Map();
  const byId = new Map();
  const byJid = new Map();
  for (const reg of db.listRegistrations()) {
    const jid = reg.jid;
    if (!jid) continue;
    byJid.set(jid, reg);
    byId.set(String(jid).split("@")[0].toLowerCase(), jid);
    for (const a of [reg.alias, ...(reg.aliases || [])]) {
      if (a) byAlias.set(normalizeAlias(a), jid);
    }
  }
  cache = { version, byAlias, byId, byJid };
  return cache;
}

/** Force the next lookup to rebuild the index (called on any registry change). */
export function invalidateRegistryCache() {
  cache = { version: -1, byAlias: new Map(), byId: new Map(), byJid: new Map() };
}

/* ─────────────────────────── resolution ─────────────────────────── */

/** Find a registration record by its bare internal id (e.g. `120363001`). */
export function findRegistrationByInternalId(id) {
  const db = getDatabase();
  const idx = buildIndex(db);
  const jid = idx.byId.get(String(id || "").trim().toLowerCase());
  return jid ? idx.byJid.get(jid) || null : null;
}

/**
 * Resolve any user-supplied target to a registered group.
 *
 * Accepts a full JID (`123@g.us`), a bare internal id (`123`) or an alias
 * (`kelas-a`). Returns `{ groupId, alias, registration }` or `null`.
 */
export function resolveGroup(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;
  const db = getDatabase();
  const idx = buildIndex(db);

  let jid = null;
  if (/@g\.us$/i.test(raw)) {
    jid = idx.byJid.has(raw) ? raw : idx.byJid.has(raw.toLowerCase()) ? raw.toLowerCase() : null;
  } else if (/^\d{5,}$/.test(raw)) {
    jid = idx.byId.get(raw) || null;
  }
  if (!jid) {
    const key = normalizeAlias(raw);
    jid = idx.byAlias.get(key) || idx.byId.get(key) || null;
  }
  if (!jid) return null;

  const registration = idx.byJid.get(jid) || db.getRegistration(jid);
  if (!registration) return null;
  return { groupId: jid, alias: registration.alias || null, registration };
}

/** Resolve any target to its canonical group JID, or `null`. */
export function normalizeGroupTarget(input) {
  const resolved = resolveGroup(input);
  return resolved ? resolved.groupId : null;
}

/* ─────────────────────────── alias management ─────────────────────────── */

/**
 * Set (or replace) the canonical alias of a registered group. Rejects invalid
 * aliases and aliases already used by a different group.
 */
export function setGroupAlias(jid, alias) {
  const db = getDatabase();
  if (!jid) return { ok: false, error: "Grup tidak valid." };
  const reg = db.getRegistration(jid);
  if (!reg) return { ok: false, error: "Grup belum terdaftar." };

  const norm = normalizeAlias(alias);
  if (!isValidAlias(norm)) {
    return {
      ok: false,
      error: "Alias tidak valid. Gunakan huruf kecil, angka, `_` atau `-` (2–32 karakter).",
    };
  }
  const existing = resolveGroup(norm);
  if (existing && existing.groupId !== jid) {
    return { ok: false, error: `Alias \`${norm}\` sudah dipakai grup lain.` };
  }

  db.setRegistrationAlias(jid, norm);
  invalidateRegistryCache();
  return { ok: true, alias: norm };
}

/* ─────────────────────────── command target helper ─────────────────────────── */

export const TARGET_REQUIRED_MESSAGE =
  "❌ *Target grup belum ditentukan.*\n\n> Gunakan: `.command <alias> ...`\n> Lihat daftar alias: `.listreg`";

export const NOT_REGISTERED_MESSAGE =
  "❌ *Group belum terdaftar.*\n\n> Daftarkan terlebih dahulu menggunakan `.registergroup`.";

export const ALIAS_NOT_FOUND_MESSAGE =
  "❌ *Alias group tidak ditemukan.*\n\n> Lihat daftar alias: `.listreg`";

export const BOT_NOT_IN_GROUP_MESSAGE =
  "❌ *Bot tidak berada di grup tersebut.*\n\n> Pastikan bot sudah bergabung sebelum mengelola grup itu.";

export const NOT_PERMITTED_MESSAGE =
  "❌ *Kamu tidak memiliki izin mengubah pengaturan grup tersebut.*\n\n> Hanya owner/whitelist atau *admin* grup target yang diizinkan.";

/** True when a token *shapes* like a group reference (JID or bare numeric id). */
export function looksLikeGroupRef(token) {
  const t = String(token || "").trim();
  if (!t) return false;
  if (/@g\.us$/i.test(t)) return true;
  if (/^\d{5,}$/.test(t)) return true;
  return false;
}

/**
 * Determine the group a command targets, using the documented priority:
 *
 *   explicit alias/id  →  current group  →  error
 *
 * @param {object} m      serialized message
 * @param {object} db     database
 * @param {{index?:number, args?:string[]}} [opts] `index` is the argument slot
 *        that may hold an explicit target (default 0).
 * @returns {{jid:string, registration:object|null, alias:string|null, explicit:boolean, consumed:number}|{error:string}}
 */
export function getTargetGroup(m, db, opts = {}) {
  const index = Number.isInteger(opts.index) ? opts.index : 0;
  const args = opts.args || m.args || [];
  const arg = args[index];
  const resolved = arg ? resolveGroup(arg) : null;

  if (resolved) {
    return {
      jid: resolved.groupId,
      registration: resolved.registration,
      alias: resolved.alias,
      explicit: true,
      consumed: 1,
    };
  }

  // A token that shapes like a group id but is not registered is an explicit
  // (remote) target that simply does not exist yet.
  if (arg && looksLikeGroupRef(arg)) {
    return { error: NOT_REGISTERED_MESSAGE, explicit: true, jid: null };
  }

  if (m.isGroup) {
    const reg = db.getRegistration(m.chat);
    return { jid: m.chat, registration: reg, alias: reg?.alias || null, explicit: false, consumed: 0 };
  }

  return { error: TARGET_REQUIRED_MESSAGE };
}

/**
 * Like `getTargetGroup`, but also enforces the remote permission model for
 * ADMIN/config commands:
 *   OWNER / WHITELIST        → allowed
 *   GROUP ADMIN of target    → allowed (when the group allows admin commands)
 *   anyone else              → denied
 *
 * The check runs for BOTH the current group and an explicit remote target, so a
 * command that became remote-capable never silently widens its own audience.
 * Registration is required for *explicit* (remote) targets only, preserving the
 * legacy "use the bot in an unregistered group" behaviour for in-group use.
 */
export async function resolveManagedTarget(m, ctx, opts = {}) {
  const target = getTargetGroup(m, ctx.db, opts);
  if (target.error) return target;

  if (target.explicit && (!target.registration || target.registration.status !== "active")) {
    return { error: NOT_REGISTERED_MESSAGE };
  }

  const allowed = await canManageGroup(m.sender, target.jid, ctx.sock);
  if (!allowed) return { error: NOT_PERMITTED_MESSAGE };

  return target;
}

/**
 * Resolver for "all"-tier DATA commands (notes / blacklist / addfilter): anyone
 * may act on their own group, but a REMOTE target still requires management
 * rights (owner/whitelist or an admin of that group).
 */
export async function resolveDataTarget(m, ctx, opts = {}) {
  const target = getTargetGroup(m, ctx.db, opts);
  if (target.error) return target;

  if (target.explicit) {
    if (!target.registration || target.registration.status !== "active") {
      return { error: NOT_REGISTERED_MESSAGE };
    }
    const allowed = await canManageGroup(m.sender, target.jid, ctx.sock);
    if (!allowed) return { error: NOT_PERMITTED_MESSAGE };
  }

  return target;
}

