/**
 * VEA — extended control commands for the remote panel.
 *
 * These handlers extend the base control socket (see control-server.js) with
 * group management, owner/whitelist, settings, scheduler, stats, media, presence
 * and session control. They are deliberately factored out so the base server stays
 * small and this surface is testable in isolation.
 *
 * Each handler is `async (server, message) => response`. The caller merges the
 * request `id` and wraps any thrown error into `{ ok:false, error }`.
 *
 * The control socket is local-only (filesystem perms) so these actions are treated
 * as trusted, but inputs are still validated and never interpolated into shell.
 */
import fs from "fs";
import path from "path";
import { getSocket, isConnected, logout } from "../core/connection.js";
import { collectGroups } from "./control-utils.js";
import { collectSystemInfo } from "./system-info.js";
import { resolveGroup, normalizeGroupTarget, invalidateRegistryCache, setGroupAlias } from "./group-registry.js";
import * as groupService from "./group-service.js";
import { getGroupMetadataCached, invalidateGroupMetadata } from "./group-cache.js";
import { normalizeToJid, numberFromJid } from "./group-utils.js";
import { GLOBAL_SCOPE } from "./group-scope.js";
import {
  isWhitelistEnabled, setWhitelistEnabled, isOwner,
  getRegistrationMode,
} from "./access.js";
import {
  getCommandsByCategory, getCategories, getConflicts, getLoadErrors, getPluginCount,
} from "./plugins.js";
import { checkForUpdates, isConfigured as updaterConfigured, getRepoLabel } from "./updater.js";
import { restartBot } from "./restart.js";

const MEDIA_MAX_BYTES = 16 * 1024 * 1024;

function requireDb(server) {
  const db = server._getDb();
  if (!db) throw new Error("database unavailable");
  return db;
}

function requireSock(server) {
  const sock = (server && typeof server._getSocket === "function" ? server._getSocket() : null) || getSocket();
  if (!sock) throw new Error("WhatsApp socket unavailable");
  return sock;
}

/**
 * Resolve a JID / bare group id / alias to a group JID without touching the live
 * database, so the handler is unit-testable. Aliases still try the registry first;
 * a raw JID or bare id is normalised directly.
 */
function resolveJid(input) {
  if (!input) throw new Error("group/target required");
  const raw = String(input).trim();
  if (raw.includes("@")) return raw;
  const digits = raw.replace(/[^0-9]/g, "");
  if (/^\d{6,}$/.test(digits)) return `${digits}@g.us`;
  try {
    const viaRegistry = resolveGroup(raw);
    if (viaRegistry?.groupId) return viaRegistry.groupId;
    const jid = normalizeGroupTarget(raw);
    if (jid) return jid;
  } catch {
    /* registry needs the live DB; nothing else to try */
  }
  throw new Error(`unknown target: ${input}`);
}

function participantJids(input) {
  const list = Array.isArray(input) ? input : [input];
  const out = [];
  for (const raw of list) {
    const jid = normalizeToJid(raw);
    if (jid) out.push(jid);
  }
  if (!out.length) throw new Error("no valid phone numbers");
  return out;
}

/* ───────────────────────── media ───────────────────────── */

function decodeMedia(message) {
  const base64 = String(message.base64 || "").trim();
  const url = String(message.url || "").trim();
  if (!base64 && !url) throw new Error("media needs base64 or url");
  let buffer = null;
  if (base64) {
    const cleaned = base64.replace(/^data:[^;]+;base64,/, "");
    buffer = Buffer.from(cleaned, "base64");
    if (buffer.length > MEDIA_MAX_BYTES) throw new Error("media too large (max 16MB)");
  }
  // Note: `message.type` is the RPC command name, so the media type rides on
  // `mediaType` to avoid the collision.
  const type = String(message.mediaType || "document").toLowerCase();
  const mimetype = message.mimetype || undefined;
  const fileName = message.fileName || undefined;
  const caption = message.caption ?? "";
  return { buffer, url, type, mimetype, fileName, caption };
}

async function sendMedia(server, message) {
  const sock = requireSock(server);
  const jid = resolveJid(message.jid);
  const { buffer, url, type, mimetype, fileName, caption } = decodeMedia(message);
  const source = buffer || url;
  const quoted = message.quoted;
  await sock.sendMedia(jid, source, caption, quoted, {
    type,
    mediaType: type,
    mimetype,
    fileName,
  });
  return { ok: true, jid, type };
}

/* ───────────────────────── presence ───────────────────────── */

async function presence(server, message) {
  const sock = requireSock(server);
  const state = String(message.state || "").toLowerCase();
  const allowed = ["composing", "paused", "available", "unavailable", "recording"];
  if (!allowed.includes(state)) throw new Error(`invalid presence: ${state}`);
  const jid = message.jid ? resolveJid(message.jid) : undefined;
  await sock.sendPresenceUpdate(state, jid);
  return { ok: true, state, jid: jid || null };
}

/* ───────────────────────── groups ───────────────────────── */

async function groupList(server) {
  const db = requireDb(server);
  return { ok: true, groups: collectGroups(db) };
}

async function groupInfo(server, message) {
  const sock = requireSock(server);
  const jid = resolveJid(message.jid);
  const meta = await getGroupMetadataCached(sock, jid);
  if (!meta) throw new Error("group metadata unavailable");
  const participants = (meta.participants || []).map((p) => ({
    jid: p.jid || p.id,
    phoneNumber: p.phoneNumber || p.id || null,
    admin: p.admin || null,
  }));
  return {
    ok: true,
    group: {
      jid: meta.id || jid,
      subject: meta.subject || "",
      description: meta.desc || "",
      owner: meta.owner || null,
      creation: meta.creation || null,
      announce: Boolean(meta.announce),
      participants,
    },
  };
}

async function groupAlias(server, message) {
  const db = requireDb(server);
  const jid = resolveJid(message.jid);
  const alias = String(message.alias || "").trim();
  if (!alias) throw new Error("alias required");
  const result = setGroupAlias(jid, alias);
  invalidateRegistryCache();
  if (!result.ok) throw new Error(result.error || "could not set alias");
  return { ok: true, jid, alias: result.alias };
}

async function groupRename(server, message) {
  const sock = requireSock(server);
  const jid = resolveJid(message.jid);
  const name = String(message.name || "").trim();
  if (!name) throw new Error("name required");
  await groupService.renameGroup(sock, jid, name);
  invalidateGroupMetadata(jid);
  return { ok: true, jid, name };
}

async function groupSetDescription(server, message) {
  const sock = requireSock(server);
  const jid = resolveJid(message.jid);
  const description = String(message.description ?? "");
  await groupService.setDescription(sock, jid, description);
  invalidateGroupMetadata(jid);
  return { ok: true, jid };
}

async function groupInvite(server, message) {
  const sock = requireSock(server);
  const jid = resolveJid(message.jid);
  const link = message.revoke
    ? await groupService.revokeInviteLink(sock, jid)
    : await groupService.getInviteLink(sock, jid);
  return { ok: true, jid, link };
}

async function groupAdd(server, message) {
  const sock = requireSock(server);
  const jid = resolveJid(message.jid);
  const numbers = participantJids(message.numbers);
  const result = await groupService.addMembers(sock, jid, numbers);
  invalidateGroupMetadata(jid);
  return { ok: true, jid, result: result || [] };
}

async function groupRemove(server, message) {
  const sock = requireSock(server);
  const jid = resolveJid(message.jid);
  const numbers = participantJids(message.numbers);
  await groupService.removeMembers(sock, jid, numbers);
  invalidateGroupMetadata(jid);
  return { ok: true, jid, removed: numbers.map(numberFromJid) };
}

async function groupPromote(server, message) {
  const sock = requireSock(server);
  const jid = resolveJid(message.jid);
  const numbers = participantJids(message.numbers);
  await groupService.promoteToAdmin(sock, jid, numbers);
  invalidateGroupMetadata(jid);
  return { ok: true, jid };
}

async function groupDemote(server, message) {
  const sock = requireSock(server);
  const jid = resolveJid(message.jid);
  const numbers = participantJids(message.numbers);
  await groupService.demoteFromAdmin(sock, jid, numbers);
  invalidateGroupMetadata(jid);
  return { ok: true, jid };
}

async function groupAnnounce(server, message) {
  const sock = requireSock(server);
  const jid = resolveJid(message.jid);
  const allow = Boolean(message.allow);
  await groupService.setMembersCanSendMessage(sock, jid, allow);
  invalidateGroupMetadata(jid);
  return { ok: true, jid, allow };
}

async function groupSettings(server, message) {
  const sock = requireSock(server);
  const jid = resolveJid(message.jid);
  const locked = message.locked;
  const approval = message.approval;
  if (locked !== undefined) await groupService.setMembersCanEditSettings(sock, jid, !locked);
  if (approval !== undefined) await groupService.setJoinApprovalRequired(sock, jid, Boolean(approval));
  invalidateGroupMetadata(jid);
  return { ok: true, jid };
}

async function groupLeave(server, message) {
  const sock = requireSock(server);
  const jid = resolveJid(message.jid);
  await sock.groupLeave(jid);
  invalidateGroupMetadata(jid);
  return { ok: true, jid };
}

/* ───────────────────────── owner / access ───────────────────────── */

async function ownerList(server) {
  const db = requireDb(server);
  const extra = db.setting("ownerNumbers");
  const owners = Array.isArray(extra) ? extra.map(String) : [];
  return { ok: true, owners };
}

async function ownerAdd(server, message) {
  const db = requireDb(server);
  const jid = normalizeToJid(message.number);
  if (!jid) throw new Error("invalid phone number");
  const num = numberFromJid(jid);
  const extra = db.setting("ownerNumbers");
  const owners = Array.isArray(extra) ? extra.map(String) : [];
  if (!owners.includes(num)) owners.push(num);
  db.setting("ownerNumbers", owners);
  return { ok: true, owners };
}

async function ownerRemove(server, message) {
  const db = requireDb(server);
  const num = String(message.number || "").replace(/[^0-9]/g, "");
  if (!num) throw new Error("invalid phone number");
  const extra = db.setting("ownerNumbers");
  const owners = (Array.isArray(extra) ? extra.map(String) : []).filter((n) => n !== num);
  db.setting("ownerNumbers", owners);
  return { ok: true, owners };
}

async function accessGet(server) {
  const db = requireDb(server);
  return {
    ok: true,
    access: {
      whitelistEnabled: isWhitelistEnabled(),
      registrationMode: getRegistrationMode(),
      whitelist: db.listWhitelist().map((w) => ({ number: String(w.number), addedBy: w.addedBy || null })),
    },
  };
}

async function accessSet(server, message) {
  const db = requireDb(server);
  if (message.whitelistEnabled !== undefined) setWhitelistEnabled(Boolean(message.whitelistEnabled));
  if (message.registrationMode !== undefined) {
    const mode = String(message.registrationMode);
    if (!["open", "closed"].includes(mode)) throw new Error("registrationMode must be open|closed");
    db.setting("regMode", mode);
  }
  if (message.addWhitelist !== undefined) db.addWhitelist(message.addWhitelist);
  if (message.removeWhitelist !== undefined) db.removeWhitelist(message.removeWhitelist);
  return accessGet(server);
}

/* ───────────────────────── settings ───────────────────────── */

function sanitizeSettings(raw) {
  const out = {};
  for (const [key, value] of Object.entries(raw || {})) {
    if (key.startsWith("_")) continue; // internal fields
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) out[key] = value;
  }
  return out;
}

async function settingsGet(server) {
  const db = requireDb(server);
  return { ok: true, settings: sanitizeSettings(db.getSettings()) };
}

async function settingsSet(server, message) {
  const db = requireDb(server);
  const patch = message.settings;
  if (!patch || typeof patch !== "object") throw new Error("settings object required");
  const applied = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === "ownerNumbers" || key === "bannedUsers") {
      throw new Error(`${key} must be edited via owner/ban commands`);
    }
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
      db.setting(key, value);
      applied[key] = value;
    }
  }
  return { ok: true, applied };
}

/* ───────────────────────── scheduler ───────────────────────── */

function publicSchedule(s) {
  return {
    id: s.id,
    jid: s.jid,
    content: s.content,
    mediaType: s.mediaType || null,
    sendTime: s.sendTime,
    recurrence: s.recurrence,
    recurrenceValue: s.recurrenceValue || null,
    active: s.active !== false,
    lastSentAt: s.lastSentAt || null,
    createdAt: s.createdAt || null,
  };
}

async function scheduleList(server, message) {
  const db = requireDb(server);
  const jid = message.jid ? resolveJid(message.jid) : null;
  return { ok: true, schedules: db.listSchedules(jid).map(publicSchedule) };
}

async function scheduleAdd(server, message) {
  const db = requireDb(server);
  const jid = message.jid === GLOBAL_SCOPE || message.global ? GLOBAL_SCOPE : resolveJid(message.jid);
  const content = String(message.content || "");
  const sendTime = String(message.sendTime || "");
  const recurrence = String(message.recurrence || "once");
  if (!/^\d{2}:\d{2}$/.test(sendTime)) throw new Error("sendTime must be HH:MM");
  if (!["daily", "weekly", "once"].includes(recurrence)) throw new Error("recurrence daily|weekly|once");
  if (!content && !message.base64) throw new Error("content required");
  const id = `sch_${Math.random().toString(36).slice(2, 10)}`;
  const record = db.createSchedule(id, {
    jid,
    content,
    mediaType: message.mediaType || null,
    mediaBase64: message.base64 || null,
    mediaMimetype: message.mimetype || null,
    sendTime,
    recurrence,
    recurrenceValue: message.recurrenceValue || null,
    createdBy: message.createdBy || "panel",
  });
  return { ok: true, schedule: publicSchedule(record) };
}

async function scheduleDelete(server, message) {
  const db = requireDb(server);
  const id = String(message.id || "");
  if (!id) throw new Error("id required");
  const removed = db.deleteSchedule(id);
  return { ok: removed, id };
}

/* ───────────────────────── stats / system ───────────────────────── */

async function stats(server) {
  const db = requireDb(server);
  return {
    ok: true,
    stats: {
      topCommands: db.getTopCommands(10),
      totalCommandUsage: db.getTotalCommandUsage(),
      commandCount: db.getCommandStatCount(),
      counters: db.getStats(),
      eventLogCount: db.eventLogCount(),
    },
  };
}

async function systemInfo(server) {
  return { ok: true, system: collectSystemInfo() };
}

/* ───────────────────────── session ───────────────────────── */

async function sessionInfo(server) {
  const sock = getSocket();
  let status = null;
  try {
    status = await server.status();
  } catch {
    status = null;
  }
  return {
    ok: true,
    session: {
      connected: isConnected(),
      hasSocket: Boolean(sock),
      status,
    },
  };
}

async function sessionLogout(server) {
  const ok = await logout();
  return { ok: Boolean(ok), loggedOut: Boolean(ok) };
}

/* ───────────────────────── per-group toggles (security + data) ───────────────────── */

const GROUP_BOOL_FLAGS = new Set([
  "antilink", "antivirtex", "antinsfw", "antibot", "allowAdminCommands",
  "registered", "isManagementGroup", "notifSholat", "mute", "welcome", "goodbye",
]);

async function groupFlags(server, message) {
  const db = requireDb(server);
  const jid = resolveJid(message.jid);
  const g = db.getGroup(jid) || {};
  return {
    ok: true,
    jid,
    flags: {
      antilink: Boolean(g.antilink),
      antivirtex: Boolean(g.antivirtex),
      antinsfw: Boolean(g.antinsfw),
      antibot: Boolean(g.antibot),
      antijudol: g.antijudol || "off",
      antijudolMode: g.antijudolMode || "kick",
      allowAdminCommands: g.allowAdminCommands !== false,
      allowSaveNote: g.allowSaveNote || "admin",
      registered: Boolean(g.registered),
      mute: Boolean(g.mute),
      welcome: Boolean(g.welcome),
      goodbye: Boolean(g.goodbye),
    },
  };
}

async function groupSetFlag(server, message) {
  const db = requireDb(server);
  const jid = resolveJid(message.jid);
  const patch = {};
  const flags = message.flags || {};
  for (const [key, value] of Object.entries(flags)) {
    if (GROUP_BOOL_FLAGS.has(key)) patch[key] = Boolean(value);
    else if (key === "antijudol" || key === "allowSaveNote" || key === "antijudolMode") {
      patch[key] = String(value);
    }
  }
  if (!Object.keys(patch).length) throw new Error("no recognised flags");
  const updated = db.setGroup(jid, patch);
  return { ok: true, jid, flags: updated };
}

/* ───────────────────────── blacklist ───────────────────────── */

async function blacklistList(server, message) {
  const db = requireDb(server);
  const scope = message.jid ? resolveJid(message.jid) : GLOBAL_SCOPE;
  return { ok: true, scope, entries: db.listBlacklist(scope) };
}

async function blacklistAdd(server, message) {
  const db = requireDb(server);
  const scope = message.jid ? resolveJid(message.jid) : GLOBAL_SCOPE;
  const entry = String(message.entry || "").trim();
  if (!entry) throw new Error("entry required");
  const record = db.addBlacklist(scope, entry, message.addedBy || "panel");
  return { ok: true, scope, entry: record };
}

async function blacklistRemove(server, message) {
  const db = requireDb(server);
  const scope = message.jid ? resolveJid(message.jid) : GLOBAL_SCOPE;
  const removed = db.removeBlacklist(scope, String(message.entry || "").trim());
  return { ok: removed, scope };
}

/* ───────────────────────── notes ───────────────────────── */

async function noteList(server, message) {
  const db = requireDb(server);
  const scope = message.jid ? resolveJid(message.jid) : GLOBAL_SCOPE;
  return { ok: true, scope, notes: db.listNotes(scope) };
}

async function noteAdd(server, message) {
  const db = requireDb(server);
  const scope = message.jid ? resolveJid(message.jid) : GLOBAL_SCOPE;
  const name = String(message.name || "").trim();
  const content = String(message.content ?? "");
  if (!name) throw new Error("name required");
  const record = db.setNote(scope, name, content, message.savedBy || "panel");
  return { ok: true, scope, note: record };
}

async function noteDelete(server, message) {
  const db = requireDb(server);
  const scope = message.jid ? resolveJid(message.jid) : GLOBAL_SCOPE;
  const removed = db.deleteNote(scope, String(message.name || "").trim());
  return { ok: removed, scope };
}

/* ───────────────────────── filters ───────────────────────── */

async function filterList(server, message) {
  const db = requireDb(server);
  const scope = message.jid ? resolveJid(message.jid) : GLOBAL_SCOPE;
  return { ok: true, scope, filters: db.listFilters(scope) };
}

async function filterAdd(server, message) {
  const db = requireDb(server);
  const scope = message.jid ? resolveJid(message.jid) : GLOBAL_SCOPE;
  const trigger = String(message.trigger || "").trim();
  const content = String(message.content ?? "");
  if (!trigger) throw new Error("trigger required");
  const record = db.setFilter(scope, trigger, { content, createdBy: message.createdBy || "panel" });
  return { ok: true, scope, filter: record };
}

async function filterDelete(server, message) {
  const db = requireDb(server);
  const scope = message.jid ? resolveJid(message.jid) : GLOBAL_SCOPE;
  const removed = db.deleteFilter(scope, String(message.trigger || "").trim());
  return { ok: removed, scope };
}

/* ───────────────────────── group registry ───────────────────────── */

function publicRegistration(r) {
  return {
    jid: r.jid,
    name: r.name || "",
    alias: r.alias || null,
    status: r.status || "active",
    activated: r.activated !== false,
    logPanel: r.logPanel || null,
    registeredBy: r.registeredBy || null,
    registeredAt: r.registeredAt || null,
  };
}

async function regList(server) {
  const db = requireDb(server);
  return { ok: true, registrations: db.listRegistrations().map(publicRegistration) };
}

async function regRegister(server, message) {
  const db = requireDb(server);
  const jid = resolveJid(message.jid);
  const record = db.registerGroup(jid, {
    name: message.name || undefined,
    alias: message.alias || undefined,
    registeredBy: message.registeredBy || "panel",
    status: "active",
    activated: true,
  });
  invalidateRegistryCache();
  return { ok: true, registration: publicRegistration(record) };
}

async function regUnregister(server, message) {
  const db = requireDb(server);
  const jid = resolveJid(message.jid);
  const removed = db.unregisterGroup(jid);
  invalidateRegistryCache();
  return { ok: removed, jid };
}

/* ───────────────────────── federation ───────────────────────── */

async function fedList(server) {
  const db = requireDb(server);
  return { ok: true, federations: db.listFederations() };
}

async function fedCreate(server, message) {
  const db = requireDb(server);
  const name = String(message.name || "").trim();
  if (!name) throw new Error("name required");
  const id = String(message.id || `fed_${Math.random().toString(36).slice(2, 8)}`);
  const record = db.createFederation(name, id, message.alias || null);
  return { ok: true, federation: record };
}

async function fedJoin(server, message) {
  const db = requireDb(server);
  const id = String(message.id || "").trim();
  const jid = resolveJid(message.jid);
  if (!id) throw new Error("federation id required");
  const record = db.joinFederation(id, jid);
  return { ok: Boolean(record), federation: record };
}

async function fedLeave(server, message) {
  const db = requireDb(server);
  const id = String(message.id || "").trim();
  const jid = resolveJid(message.jid);
  const removed = db.leaveFederation(id, jid);
  return { ok: Boolean(removed) };
}

/* ───────────────────────── feature scopes (link) ───────────────────────── */

async function scopeList(server, message) {
  const db = requireDb(server);
  return { ok: true, scopes: db.listScopes(message.feature || null) };
}

async function scopeCreate(server, message) {
  const db = requireDb(server);
  const feature = String(message.feature || "").trim();
  const groups = (Array.isArray(message.groups) ? message.groups : []).map(resolveJid);
  const record = db.createScope(feature, groups);
  if (!record) throw new Error("need a feature and at least 2 groups");
  return { ok: true, scope: record };
}

/* ───────────────────────── owners / access lists ───────────────────────── */

async function bannedList(server) {
  const db = requireDb(server);
  const list = db.setting("bannedUsers");
  return { ok: true, banned: Array.isArray(list) ? list : [] };
}

async function bannedAdd(server, message) {
  const db = requireDb(server);
  const jid = normalizeToJid(message.number);
  if (!jid) throw new Error("invalid number");
  const num = numberFromJid(jid);
  const list = db.setting("bannedUsers");
  const banned = Array.isArray(list) ? list : [];
  if (!banned.includes(num)) banned.push(num);
  db.setting("bannedUsers", banned);
  return { ok: true, banned };
}

async function bannedRemove(server, message) {
  const db = requireDb(server);
  const num = String(message.number || "").replace(/[^0-9]/g, "");
  const list = db.setting("bannedUsers");
  const banned = (Array.isArray(list) ? list : []).filter((n) => n !== num);
  db.setting("bannedUsers", banned);
  return { ok: true, banned };
}

/* ───────────────────────── moderation log ───────────────────────── */

async function eventLogs(server, message) {
  const db = requireDb(server);
  const limit = Math.min(Math.max(Number(message.limit) || 50, 1), 500);
  return {
    ok: true,
    count: db.eventLogCount(),
    logs: db.listEventLogs(limit, {}),
  };
}

/* ───────────────────────── plugin registry / health ───────────────────────── */

async function pluginInfo(server) {
  return {
    ok: true,
    info: {
      count: getPluginCount(),
      categories: getCategories(),
      byCategory: getCommandsByCategory(),
      conflicts: getConflicts(),
      loadErrors: getLoadErrors(),
    },
  };
}

/* ───────────────────────── update check (read-only) ───────────────────────── */

async function updateCheck(server, message) {
  if (!updaterConfigured()) {
    return { ok: false, error: "updater not configured", configured: false };
  }
  const result = await checkForUpdates({ ref: String(message.ref || "") });
  return { ok: true, configured: true, repo: getRepoLabel(message.ref || ""), result };
}

/* ───────────────────────── restart (ext alias) ───────────────────────── */

async function restart(server) {
  await restartBot({ reason: "panel" }).catch(() => {});
  return { ok: true, action: "restart" };
}

/* ───────────────────────── .env editor ───────────────────────── */

/** Keys treated as secrets: returned masked and never echoed back. */
const SECRET_KEYS = /(TOKEN|PASSWORD|KEY|SECRET|API_KEY)/i;

function envPath() {
  return path.join(process.cwd(), ".env");
}

function parseEnv(text) {
  const entries = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      entries.push({ type: "raw", raw: line });
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) {
      entries.push({ type: "raw", raw: line });
      continue;
    }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1);
    // Preserve inline comments conservatively: only strip surrounding quotes.
    entries.push({ type: "kv", key, value });
  }
  return entries;
}

async function envList() {
  const file = envPath();
  if (!fs.existsSync(file)) return { ok: true, exists: false, entries: [] };
  const text = fs.readFileSync(file, "utf8");
  const entries = parseEnv(text)
    .filter((e) => e.type === "kv")
    .map((e) => {
      const secret = SECRET_KEYS.test(e.key);
      const present = e.value !== "";
      return {
        key: e.key,
        value: secret ? (present ? "********" : "") : e.value,
        secret,
        set: present,
      };
    });
  return { ok: true, exists: true, entries };
}

async function envSet(server, message) {
  const file = envPath();
  const updates = message.values;
  if (!updates || typeof updates !== "object") throw new Error("values object required");
  const original = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const entries = parseEnv(original);
  const seen = new Set();
  for (const e of entries) {
    if (e.type !== "kv") continue;
    if (Object.prototype.hasOwnProperty.call(updates, e.key)) {
      const value = updates[e.key];
      if (SECRET_KEYS.test(e.key) && (value === "********" || value === undefined)) {
        seen.add(e.key);
        continue; // keep existing secret untouched
      }
      e.value = String(value ?? "");
      seen.add(e.key);
    }
  }
  const applied = {};
  for (const [key, value] of Object.entries(updates)) {
    if (!/^[A-Za-z0-9_]+$/.test(key)) throw new Error(`invalid env key: ${key}`);
    applied[key] = SECRET_KEYS.test(key) ? "********" : String(value ?? "");
    if (seen.has(key)) continue;
    entries.push({ type: "kv", key, value: String(value ?? "") });
  }
  const out = entries
    .map((e) => (e.type === "raw" ? e.raw : `${e.key}=${e.value}`))
    .join("\n");
  fs.writeFileSync(file, out.endsWith("\n") ? out : `${out}\n`, "utf8");
  return { ok: true, applied, restartRequired: true };
}

/* ───────────────────────── settings option catalog ───────────────────────── */

/** Choices for settings the panel should render as a dropdown instead of free text. */
const SETTINGS_CATALOG = {
  botMode: { label: "Bot mode", type: "enum", options: ["public", "self", "private", "group", "reggroup"] },
  regMode: { label: "Registration gate", type: "enum", options: ["open", "registered"] },
  silentLevel: { label: "Silent level", type: "enum", options: ["off", "on", "super"] },
  whitelistEnabled: { label: "Whitelist", type: "bool" },
  antivirtexdm: { label: "Anti-virtex DM report", type: "bool" },
  anticulik: { label: "Anti-culik (auto leave)", type: "bool" },
  logScope: { label: "Log scope", type: "enum", options: ["registered", "public"] },
  rvoScope: { label: "RVO scope", type: "enum", options: ["registered", "public"] },
  rvoAccess: { label: "RVO access", type: "enum", options: ["owner", "admin", "public"] },
  rvoDelivery: { label: "RVO delivery", type: "enum", options: ["default", "private"] },
  backupDelivery: { label: "Backup delivery", type: "enum", options: ["whatsapp", "hosting"] },
  backupScope: { label: "Backup scope", type: "enum", options: ["full", "source"] },
  altheora_simak_access: { label: "SIMAK access", type: "enum", options: ["owner", "public"] },
  presenceSim: { label: "Presence simulation", type: "bool" },
  logRetentionDays: { label: "Log retention (days)", type: "int", min: 1, max: 365 },
  quoteMaxChars: { label: "Quote max chars", type: "int", min: 0, max: 200 },
  revokeMaxBytes: { label: "Revoke max bytes", type: "int", min: 0, max: 52428800 },
  bulkDelayMin: { label: "Bulk delay min (ms)", type: "int", min: 0, max: 60000 },
  bulkDelayMax: { label: "Bulk delay max (ms)", type: "int", min: 0, max: 60000 },
  presenceDelayMin: { label: "Presence delay min (ms)", type: "int", min: 0, max: 60000 },
  presenceDelayMax: { label: "Presence delay max (ms)", type: "int", min: 0, max: 60000 },
  timezone: { label: "Timezone", type: "text" },
  selfMode: { label: "Self mode", type: "bool" },
  defaultLogPanel: { label: "Default log panel (jid)", type: "jid" },
};

async function settingsOptions() {
  return { ok: true, catalog: SETTINGS_CATALOG };
}

/* ───────────────────────── registry ───────────────────────── */

/** Map of message `type` -> handler. */
export const EXT_HANDLERS = {
  media: sendMedia,
  presence,
  "group-list": groupList,
  "group-info": groupInfo,
  "group-alias": groupAlias,
  "group-rename": groupRename,
  "group-description": groupSetDescription,
  "group-invite": groupInvite,
  "group-add": groupAdd,
  "group-remove": groupRemove,
  "group-promote": groupPromote,
  "group-demote": groupDemote,
  "group-announce": groupAnnounce,
  "group-settings": groupSettings,
  "group-leave": groupLeave,
  "owner-list": ownerList,
  "owner-add": ownerAdd,
  "owner-remove": ownerRemove,
  "access-get": accessGet,
  "access-set": accessSet,
  "settings-get": settingsGet,
  "settings-set": settingsSet,
  "schedule-list": scheduleList,
  "schedule-add": scheduleAdd,
  "schedule-delete": scheduleDelete,
  stats,
  "system-info": systemInfo,
  "session-info": sessionInfo,
  "session-logout": sessionLogout,
  // per-group security/data toggles
  "group-flags": groupFlags,
  "group-set-flags": groupSetFlag,
  // blacklist / notes / filters
  "blacklist-list": blacklistList,
  "blacklist-add": blacklistAdd,
  "blacklist-remove": blacklistRemove,
  "note-list": noteList,
  "note-add": noteAdd,
  "note-delete": noteDelete,
  "filter-list": filterList,
  "filter-add": filterAdd,
  "filter-delete": filterDelete,
  // group registry
  "reg-list": regList,
  "reg-register": regRegister,
  "reg-unregister": regUnregister,
  // federation
  "fed-list": fedList,
  "fed-create": fedCreate,
  "fed-join": fedJoin,
  "fed-leave": fedLeave,
  // feature scopes (link)
  "scope-list": scopeList,
  "scope-create": scopeCreate,
  // banned list
  "banned-list": bannedList,
  "banned-add": bannedAdd,
  "banned-remove": bannedRemove,
  // moderation log
  "event-logs": eventLogs,
  // plugin registry / health
  "plugin-info": pluginInfo,
  // update check + restart
  "update-check": updateCheck,
  restart2: restart,
  // .env editor + settings option catalog
  "env-list": envList,
  "env-set": envSet,
  "settings-options": settingsOptions,
};

/** True when `type` is handled by this extended module. */
export function isExtCommand(type) {
  return Object.prototype.hasOwnProperty.call(EXT_HANDLERS, type);
}

/** Dispatch one extended command, returning the response payload (without id). */
export async function runExtCommand(server, message) {
  const handler = EXT_HANDLERS[message.type];
  if (!handler) throw new Error(`unknown extended request: ${message.type}`);
  return handler(server, message);
}
