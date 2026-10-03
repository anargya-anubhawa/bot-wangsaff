/**
 * GX-ID — media helpers
 *
 * Wraps Baileys' `downloadMediaMessage` and figures out a simple media type
 * label for a message, used by notes, filters, reports, the scheduler, the
 * sticker/media commands and view-once retrieval.
 */
import { downloadMediaMessage, getContentType } from "@whiskeysockets/baileys";
import { logger } from "./logger.js";

/** Recognised media labels. */
export const MEDIA_TYPES = ["image", "video", "audio", "sticker", "document"];

/** Best-effort media type of an `m`-style object or a raw proto message. */
export function detectMediaType(message) {
  if (!message) return null;
  // `m`-style flags first (already normalised by the serializer).
  if (message.isImage) return "image";
  if (message.isVideo) return "video";
  if (message.isAudio) return "audio";
  if (message.isSticker) return "sticker";
  if (message.isDocument) return "document";
  // Raw proto message.
  if (message.imageMessage) return "image";
  if (message.videoMessage) return "video";
  if (message.audioMessage) return "audio";
  if (message.stickerMessage) return "sticker";
  if (message.documentMessage) return "document";
  return null;
}

/** MIME type carried by whichever media field the message holds. */
export function getMimetype(message) {
  if (!message) return "";
  return (
    message.mimetype ||
    message.imageMessage?.mimetype ||
    message.videoMessage?.mimetype ||
    message.audioMessage?.mimetype ||
    message.stickerMessage?.mimetype ||
    message.documentMessage?.mimetype ||
    ""
  );
}

/** True when a media type is an animated (video/gif/animated-sticker) format. */
export function isAnimatedMedia(message) {
  const type = detectMediaType(message);
  if (type === "video") return true;
  if (type === "sticker") return !!message?.stickerMessage?.isAnimated || !!message?.isAnimated;
  const mimetype = getMimetype(message);
  return mimetype.includes("gif");
}

/**
 * Download the media carried by an `m`-style object or a raw proto message.
 * Accepts:
 *   - a serialized `m` / `m.quoted` (has `.download()`), or
 *   - `{ message, key }` (a WAMessage), or
 *   - a raw `proto.IMessage`.
 *
 * @returns {Promise<Buffer|null>}
 */
export async function downloadMedia(target, sock = null) {
  if (!target) return null;

  // Serialized `m` / quoted message — it already knows how to download itself.
  if (typeof target.download === "function") {
    try {
      return await target.download();
    } catch (error) {
      logger.error(`media download failed: ${error.message}`);
      return null;
    }
  }

  // A WAMessage ({ key, message }) or a raw IMessage.
  const message = target.message || target;
  const type = getContentType(message) || detectMediaType(message);
  if (!type) return null;

  try {
    const buffer = await downloadMediaMessage(
      { key: target.key || {}, message },
      "buffer",
      {},
      {
        logger,
        reuploadRequest: sock?.updateMediaMessage,
      },
    );
    return buffer;
  } catch (error) {
    logger.error(`media download failed: ${error.message}`);
    return null;
  }
}

/**
 * Wrap a raw `proto.IMessage` as a minimal WAMessage so Baileys can download it
 * (used when only the quoted proto is available).
 */
export function wrapAsWAMessage(message, referenceMsg) {
  return {
    key: referenceMsg?.key || {},
    message,
    messageTimestamp: referenceMsg?.messageTimestamp,
  };
}
