/**
 * GX-ID — centralised moderation / event logger
 *
 * ONE service every moderation path funnels through — antilink, antivirtex,
 * antinsfw, blacklist, filters, reports and message revokes never grow their own
 * logger. It:
 *
 *   1. persists a structured event (retention-pruned), and
 *   2. posts a formatted notice to the group's configured *log panel*.
 *
 * Loop-safety: a notice sent by this logger is tagged, and the panel group is
 * skipped while the notice is in flight, so a log line that itself trips a
 * filter can never recurse (`event → log → log filtered → log → …`).
 */
import { randomUUID } from "crypto";
import { getDatabase } from "./database.js";
import { getConfiguredTimezone, getCurrentTimeParts, getLogScope, getDefaultLogPanel } from "./settings.js";
import { logger } from "./logger.js";

/** Panels currently receiving a notice (loop guard). */
const inFlightPanels = new Set();

const DEFAULT_RETENTION_DAYS = 14;

/** Redact anything that could carry a secret/link payload out of a preview. */
function safePreview(value, max = 160) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const redacted = text.replace(/https?:\/\/\S+/gi, "[link]");
  return redacted.length > max ? `${redacted.slice(0, max)}…` : redacted;
}

export function getLogRetentionDays() {
  try {
    const value = Number(getDatabase().setting("logRetentionDays"));
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_RETENTION_DAYS;
  } catch {
    return DEFAULT_RETENTION_DAYS;
  }
}

export function setLogRetentionDays(days) {
  try {
    getDatabase().setting("logRetentionDays", Number(days) || DEFAULT_RETENTION_DAYS);
  } catch {
    /* ignore */
  }
}

/**
 * The chat a group's moderation notices are posted to.
 *
 *   registered group, explicit panel → that panel
 *   registered group, no panel       → the GLOBAL default panel (falling back to
 *                                      the group itself only when none is set)
 *   non-registered group             → the global default panel, but ONLY when
 *                                      the log scope is `public`; otherwise null
 *
 * Registering a group therefore routes its logs to the owner's global panel by
 * default — a group only falls back to its own chat when no default panel has
 * been configured.
 */
export function getLogPanel(groupId) {
  try {
    const db = getDatabase();
    const reg = db.getRegistration(groupId);
    const fallback = getDefaultLogPanel();
    if (reg) {
      if (reg.logPanel) return reg.logPanel;
      if (fallback && fallback !== groupId) return fallback;
      return groupId;
    }
    if (getLogScope() === "public" && fallback && fallback !== groupId) return fallback;
    return null;
  } catch {
    return null;
  }
}

/**
 * The chat a group's log should be forwarded to, or `null` when there is
 * nowhere *external* to forward to. Unlike `getLogPanel`, this returns `null`
 * when the panel is the group itself — the group already sees its own messages,
 * so there is nothing to forward there (and it avoids duplicate notices).
 */
export function getExternalLogPanel(groupId) {
  const panel = getLogPanel(groupId);
  return panel && panel !== groupId ? panel : null;
}

/** True while a logger notice is being delivered to `jid` (loop guard). */
export function isLogPanelMessage(jid) {
  return inFlightPanels.has(jid);
}

const REASON_LABEL = {
  antilink: "ANTILINK",
  antivirtex: "ANTIVIRTEX",
  antinsfw: "ANTI-NSFW",
  blacklist: "BLACKLIST",
  filter: "FILTER",
  moderation: "MODERATION",
  manual: "MANUAL",
  del: "ADMIN DELETE",
  rvo: "RVO",
  report: "REPORT",
};

const ACTION_LABEL = {
  delete: "MESSAGE DELETED",
  revoked: "MESSAGE REVOKED",
  rvo: "VIEW-ONCE OPENED",
  report: "MESSAGE REPORTED",
};

function formatTime(date = new Date()) {
  try {
    const tz = getConfiguredTimezone();
    const p = getCurrentTimeParts(tz, date);
    return `${p.ddmmyyyy} ${p.hhmm}`;
  } catch {
    return date.toISOString();
  }
}

function buildNotice(event, groupName, alias) {
  const lines = [
    "╭━━━「 🛡️ GX-ID LOG 」━━━╮",
    "┃",
    `┃ Event   : ${ACTION_LABEL[event.action] || String(event.action).toUpperCase()}`,
  ];
  if (event.reason) lines.push(`┃ Reason  : ${REASON_LABEL[event.reason] || String(event.reason).toUpperCase()}`);
  if (groupName) lines.push(`┃ Group   : ${groupName}`);
  if (alias) lines.push(`┃ Alias   : ${alias}`);
  if (event.actorId) lines.push(`┃ User    : @${String(event.actorId).split("@")[0]}`);
  if (event.metadata?.detail) lines.push(`┃ Detail  : ${event.metadata.detail}`);
  lines.push(`┃ Time    : ${formatTime()}`);
  lines.push("┃");
  if (event.messageId) {
    lines.push("┃ Message ID:");
    lines.push(`┃ ${String(event.messageId).slice(0, 24)}`);
    lines.push("┃");
  }
  if (event.contentPreview) {
    lines.push("┃ Message:");
    lines.push(`┃ ${event.contentPreview}`);
    lines.push("┃");
  }
  lines.push("╰━━━━━━━━━━━━━━━━━━━━━━╯");
  return lines.join("\n");
}

/**
 * Build the message payload that forwards `media` to the panel, preserving its
 * kind. Returns null when there is nothing to forward.
 */
function buildForward(media, caption) {
  if (!media?.buffer?.length) return null;
  const buffer = media.buffer;
  switch (media.mediaType) {
    case "image":
      return { image: buffer, caption };
    case "video":
      return { video: buffer, caption, mimetype: media.mimetype || "video/mp4" };
    case "audio":
      return { audio: buffer, mimetype: media.mimetype || "audio/mp4" };
    case "sticker":
      return { sticker: buffer };
    case "document":
      return {
        document: buffer,
        mimetype: media.mimetype || "application/octet-stream",
        fileName: media.fileName || "file",
        caption,
      };
    default:
      return null;
  }
}

/**
 * Record a moderation/message event and (best-effort) forward it to the log
 * panel.
 *
 * Delivery rules (kept deliberately non-duplicating):
 *   - panel is an EXTERNAL chat  → forward the notice there, plus the media
 *     itself when one is supplied (e.g. a revoked photo/video).
 *   - panel is the group itself  → only revokes are echoed in-group (deletes
 *     already produce an in-group notice from `actionMessage`).
 *   - no panel (unregistered)    → persist only.
 *
 * @param {object} event
 * @param {"moderation"|"message"} [event.type]
 * @param {"delete"|"revoked"|"report"} [event.action]
 * @param {string} [event.reason]     antilink|antivirtex|antinsfw|blacklist|…
 * @param {string} [event.groupId]
 * @param {string} [event.actorId]
 * @param {string} [event.targetId]
 * @param {string} [event.messageId]
 * @param {string} [event.contentPreview]
 * @param {object} [event.metadata]
 * @param {{buffer:Buffer, mediaType:string, mimetype?:string, fileName?:string}} [event.media]
 * @param {object} [sock]             socket used to deliver the panel notice
 */
export async function logModerationEvent(event = {}, sock = null) {
  let db;
  try {
    db = getDatabase();
  } catch {
    return null;
  }

  const groupId = event.groupId || null;
  const reg = groupId ? db.getRegistration(groupId) : null;
  const record = {
    id: randomUUID(),
    type: event.type || "moderation",
    action: event.action || "delete",
    reason: event.reason || null,
    groupId,
    groupAlias: reg?.alias || null,
    actorId: event.actorId || null,
    targetId: event.targetId || null,
    messageId: event.messageId || null,
    contentPreview: event.contentPreview ? safePreview(event.contentPreview) : null,
    metadata: { ...(event.metadata || {}) },
    createdAt: new Date().toISOString(),
  };
  if (event.media?.mediaType) record.metadata.hasMedia = true;

  try {
    db.addEventLog(record);
  } catch (error) {
    logger.warn(`[eventlog] persist failed: ${error.message}`);
  }

  if (sock && groupId) {
    const panel = getLogPanel(groupId);
    const external = panel && panel !== groupId;
    const shouldEchoInGroup = panel === groupId && record.action === "revoked";
    if ((external || shouldEchoInGroup) && panel && !inFlightPanels.has(panel)) {
      inFlightPanels.add(panel);
      try {
        const groupName = db.getGroup(groupId)?.name || reg?.name || String(groupId).split("@")[0];
        const text = buildNotice(record, groupName, reg?.alias || null);
        const mentions = record.actorId ? [record.actorId] : [];
        const forward = external ? buildForward(event.media, text) : null;
        await sock.sendMessage(panel, forward || { text, mentions });
      } catch (error) {
        logger.warn(`[eventlog] panel delivery failed: ${error.message}`);
      } finally {
        inFlightPanels.delete(panel);
      }
    }
  }

  return record;
}

/** Delete events older than the retention window. Returns the removed count. */
export function pruneEventLogs() {
  try {
    const days = getLogRetentionDays();
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    return getDatabase().pruneEventLogs(cutoff);
  } catch {
    return 0;
  }
}
