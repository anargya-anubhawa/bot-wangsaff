/**
 * GX-ID — extended control commands for the remote panel.
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
