/**
 * GX-ID — filter service (group auto-replies)
 *
 * A group "filter" maps an exact trigger phrase to a saved response (text or
 * media). When a non-command group message equals a trigger, the response is
 * sent. Firing is rate-limited per group through the shared cooldown service
 * (`FILTER_COOLDOWN_KEY`) so a busy group is not spammed.
 *
 * Returns `true` when a filter consumed the message.
 */
import { getDatabase } from "./database.js";
import { findFilterMatch } from "./content-detectors.js";
import { checkGroupCooldown, applyGroupCooldown, getFilterCooldown, FILTER_COOLDOWN_KEY } from "./cooldown.js";
import { isOwnerOrWhitelistedIn, isGroupAdmin } from "./access.js";
import { sendWithPresence } from "./presence.js";
import { logModerationEvent, isLogPanelMessage } from "./moderation-log.js";
import { listEffectiveFilters } from "./group-scope.js";

function buildContent(filter) {
  if (filter.mediaBase64 && filter.mediaType) {
    const buffer = Buffer.from(filter.mediaBase64, "base64");
    const caption = filter.content || undefined;
    switch (filter.mediaType) {
      case "image":
        return { image: buffer, caption };
      case "video":
        return { video: buffer, caption };
      case "audio":
        return { audio: buffer, mimetype: filter.mediaMimetype || "audio/mp4" };
      case "sticker":
        return { sticker: buffer };
      case "document":
        return {
          document: buffer,
          mimetype: filter.mediaMimetype || "application/octet-stream",
          fileName: filter.fileName || "file",
          caption,
        };
      default:
        return { text: filter.content || "" };
    }
  }
  return { text: filter.content || "" };
}

/**
 * @param {object} m serialized message (non-command, group)
 * @param {object} sock
 * @returns {Promise<boolean>} true when a filter replied
 */
export async function runFilters(m, sock) {
  if (!m?.isGroup || m.isCommand) return false;
  // A log-panel notice must never trigger a filter (would recurse).
  if (isLogPanelMessage(m.chat)) return false;

  let db;
  try {
    db = getDatabase();
  } catch {
    return false;
  }

  const filters = listEffectiveFilters(db, m.chat);
  if (!filters.length) return false;

  const body = String(m.body || "").trim();
  if (!body) return false;

  const trigger = findFilterMatch(body, filters.map((f) => f.trigger));
  if (!trigger) return false;

  const filter = filters.find((f) => f.trigger === trigger);
  if (!filter) return false;

  /* rate-limit firing for ordinary users (owner/whitelist/admin exempt;
     the whitelist counts only outside a group) */
  const exempt = m.isOwner || m.fromMe || isOwnerOrWhitelistedIn(m) || isGroupAdmin(m);
  if (!exempt) {
    const cooldown = getFilterCooldown(m.chat);
    const check = checkGroupCooldown(m.chat, m.sender, FILTER_COOLDOWN_KEY, cooldown);
    if (!check.allowed) return false;
  }

  try {
    await sendWithPresence(sock, m.chat, buildContent(filter), { quoted: m.raw });
    if (!exempt) applyGroupCooldown(m.chat, m.sender, FILTER_COOLDOWN_KEY);
    // Persist the firing for the event log (no panel post: filters are frequent
    // and would spam the panel; the record is still retained/pruned).
    await logModerationEvent({
      type: "moderation",
      action: "filter",
      reason: "filter",
      groupId: m.chat,
      actorId: m.sender,
      messageId: m.id,
      contentPreview: body,
      metadata: { matched: trigger },
    });
  } catch {
    return false;
  }
  return true;
}
