/**
 * GX-ID — moderation service
 *
 * One entry point the message pipeline calls for every live group message.
 * Ties together the individual detectors (link / virtex / blacklist / NSFW),
 * the group's per-feature toggles, the admin exemption and the deletion.
 *
 * Policy: the owner, the global whitelist AND group admins are exempt from all
 * checks (consistent with the reference project) so admins can still post
 * links/warnings. `antilink`/`antivirtex`/`antinsfw` are per-group toggles;
 * the blacklist is active whenever the group has at least one entry.
 *
 * Returns `true` when the message was actioned (deleted) so the pipeline can
 * stop processing it.
 */
import { getDatabase } from "./database.js";
import { isOwnerOrWhitelistedIn, isGroupAdmin } from "./access.js";
import { containsLink, isVirtexLike, findBlacklistMatch } from "./content-detectors.js";
import { detectMediaType, downloadMedia, isAnimatedMedia, getMimetype } from "./media.js";
import { classifyImageBuffer, classifyAnimatedBuffer, isNsfwDetectorConfigured } from "./nsfw.js";
import { isBotAdminCached } from "./group-cache.js";
import { logModerationEvent, isLogPanelMessage, getExternalLogPanel } from "./moderation-log.js";
import { listEffectiveBlacklist } from "./group-scope.js";
import { logger } from "./logger.js";

const ACTIONS = {
  antilink: { label: "Antilink", reason: "link terdeteksi" },
  antivirtex: { label: "Antivirtex", reason: "konten virtex terdeteksi" },
  antinsfw: { label: "Antinsfw", reason: "konten tidak pantas terdeteksi" },
  blacklist: { label: "Blacklist", reason: "kata terlarang terdeteksi" },
};

/** Human-readable body used by the warning message. */
function preview(m) {
  const text = String(m.body || m.text || "").replace(/\s+/g, " ").trim();
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

/**
 * Delete `m` (best-effort) and post a short notice. Failures are swallowed.
 */
async function actionMessage(sock, m, kind, extra = "") {
  try {
    await sock.sendMessage(m.chat, { delete: m.key });
  } catch (error) {
    logger.warn(`[moderation] delete failed (${kind}): ${error.message}`);
  }
  try {
    const info = ACTIONS[kind] || { label: kind, reason: "" };
    const who = m.sender ? `@${String(m.sender).split("@")[0]}` : "pesan";
    const text = `🛡️ *${info.label}*\n\n> Pesan dari ${who} dihapus${extra ? ` — ${extra}` : `: ${info.reason}`}.`;
    await sock.sendMessage(m.chat, { text, mentions: m.sender ? [m.sender] : [] });
  } catch {
    /* notice is best-effort */
  }
}

/**
 * Download `m`'s media for forwarding to a log panel — only when the group has
 * an EXTERNAL panel (nothing to forward to otherwise). Best-effort; returns null
 * on any failure or when the media is too large.
 */
const MAX_FORWARD_BYTES = 8 * 1024 * 1024;
async function gatherForwardMedia(m, sock) {
  if (!getExternalLogPanel(m.chat)) return null;
  const mediaType = detectMediaType(m);
  if (!mediaType) return null;
  try {
    const buffer = await downloadMedia(m, sock);
    if (!buffer || buffer.length > MAX_FORWARD_BYTES) return null;
    return { buffer, mediaType, mimetype: getMimetype(m), fileName: m.fileName || "" };
  } catch {
    return null;
  }
}

/**
 * @param {object} m serialized message
 * @param {object} sock socket
 * @returns {Promise<boolean>} true when the message was actioned
 */
export async function runModeration(m, sock) {
  if (!m?.isGroup || !m.key) return false;

  // Never moderate the log panel's own notices — otherwise a log line that
  // itself trips a filter would recurse forever.
  if (isLogPanelMessage(m.chat)) return false;

  // Owner / group-admin are exempt from every check. The whitelist is a
  // private-chat privilege only, so inside a group it grants no exemption.
  if (m.isOwner || m.fromMe) return false;
  if (isOwnerOrWhitelistedIn(m)) return false;
  if (isGroupAdmin(m)) return false;

  let db;
  try {
    db = getDatabase();
  } catch {
    return false;
  }

  const group = db.getGroup(m.chat) || {};
  const body = String(m.body || m.text || "");

  /* antilink */
  if (group.antilink && containsLink(body)) {
    if (await ensureBotCanAct(sock, m)) {
      const media = await gatherForwardMedia(m, sock);
      await actionMessage(sock, m, "antilink");
      await logModerationEvent(
        {
          type: "moderation",
          action: "delete",
          reason: "antilink",
          groupId: m.chat,
          actorId: m.sender,
          messageId: m.id,
          contentPreview: body,
          media,
          metadata: { detail: firstLink(body) },
        },
        sock,
      );
      return true;
    }
  }

  /* antivirtex */
  if (group.antivirtex && isVirtexLike(body)) {
    if (await ensureBotCanAct(sock, m)) {
      const media = await gatherForwardMedia(m, sock);
      await actionMessage(sock, m, "antivirtex");
      await logModerationEvent(
        {
          type: "moderation",
          action: "delete",
          reason: "antivirtex",
          groupId: m.chat,
          actorId: m.sender,
          messageId: m.id,
          media,
          metadata: { detail: `panjang ${body.length} karakter` },
        },
        sock,
      );
      return true;
    }
  }

  /* blacklist (may be shared between linked groups) */
  const entries = listEffectiveBlacklist(db, m.chat).map((e) => e.entry);
  if (entries.length) {
    const hit = findBlacklistMatch(body, entries);
    if (hit) {
      if (await ensureBotCanAct(sock, m)) {
        const media = await gatherForwardMedia(m, sock);
        await actionMessage(sock, m, "blacklist", `kata \`${hit}\``);
        await logModerationEvent(
          {
            type: "moderation",
            action: "delete",
            reason: "blacklist",
            groupId: m.chat,
            actorId: m.sender,
            messageId: m.id,
            contentPreview: body,
            media,
            metadata: { matched: hit },
          },
          sock,
        );
        return true;
      }
    }
  }

  /* antinsfw (images + animated media, and only when a classifier is configured) */
  if (group.antinsfw && isNsfwDetectorConfigured()) {
    const type = detectMediaType(m);
    const isAnimated = type === "video" || type === "sticker" ? isAnimatedMedia(m) : false;
    if (type === "image" || isAnimated) {
      try {
        const buffer = await downloadMedia(m, sock);
        if (buffer) {
          const result = isAnimated
            ? await classifyAnimatedBuffer(buffer, getMimetype(m))
            : await classifyImageBuffer(buffer);
          if (result.available && result.isNsfw) {
            if (await ensureBotCanAct(sock, m)) {
              const media =
                buffer.length <= MAX_FORWARD_BYTES
                  ? { buffer, mediaType: type, mimetype: getMimetype(m), fileName: m.fileName || "" }
                  : null;
              await actionMessage(sock, m, "antinsfw");
              await logModerationEvent(
                {
                  type: "moderation",
                  action: "delete",
                  reason: "antinsfw",
                  groupId: m.chat,
                  actorId: m.sender,
                  messageId: m.id,
                  media,
                  metadata: { mediaType: isAnimated ? "animated" : "image", score: result.score ?? null },
                },
                sock,
              );
              return true;
            }
          }
        }
      } catch (error) {
        logger.warn(`[moderation] antinsfw failed: ${error.message}`);
      }
    }
  }

  return false;
}

/** Extract the first URL/domain from a message for a redacted antilink log. */
function firstLink(text) {
  const match = String(text || "").match(/(https?:\/\/[^\s]+)|(\b[a-z0-9-]+\.(com|net|org|co|id|io|me|link|xyz|info|biz|ly|gg|to|dev|app)\b\S*)/i);
  if (!match) return "";
  const raw = match[0];
  try {
    return new URL(raw.startsWith("http") ? raw : `http://${raw}`).host;
  } catch {
    return raw.slice(0, 60);
  }
}

/**
 * Deleting another member's message requires the bot to be a group admin.
 * When it is not, we do not pretend to moderate (no phantom "deleted" notice).
 */
async function ensureBotCanAct(sock, m) {
  if (m.isBotAdmin) return true;
  try {
    return await isBotAdminCached(sock, m.chat);
  } catch {
    return false;
  }
}

/**
 * Anti-virtex for direct messages: when the owner enabled `antivirtexdm`, a
 * virtex-like private message is reported to the owner rather than deleted.
 */
export async function runDirectVirtexCheck(m, sock, ownerNumbers) {
  if (m.isGroup) return false;
  let db;
  try {
    db = getDatabase();
  } catch {
    return false;
  }
  if (!db.setting("antivirtexdm")) return false;
  if (m.isOwner || isOwnerOrWhitelistedIn(m)) return false;
  if (!isVirtexLike(String(m.body || ""))) return false;

  const owners = Array.isArray(ownerNumbers) ? ownerNumbers : [];
  const text = `⚠️ *Antivirtex (DM)*\n\n> Dari: @${String(m.sender).split("@")[0]}\n> Preview: ${preview(m)}`;
  for (const owner of owners) {
    try {
      await sock.sendMessage(`${owner}@s.whatsapp.net`, { text, mentions: [m.sender] });
    } catch {
      /* ignore */
    }
  }
  return true;
}
