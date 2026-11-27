/**
 * VEA — message context helpers
 *
 * `saluranCtx()` builds the "forwarded from channel" context used across the
 * bot. `interactiveContextInfo()` builds the `messageContextInfo` that
 * interactive (native-flow) messages require.
 */
import { randomBytes } from "crypto";
import config from "../config.js";

/**
 * Build the `messageContextInfo` required by interactive / native-flow
 * messages. WhatsApp silently drops interactive messages whose context is
 * missing a 32-byte `messageSecret`, so it MUST be injected inside the
 * `viewOnceMessage.message` wrapper (mirrors the reference architecture).
 */
export function interactiveContextInfo(extra = {}) {
  return {
    deviceListMetadata: {},
    deviceListMetadataVersion: 2,
    messageSecret: randomBytes(32),
    ...extra,
  };
}

export function saluranCtx() {
  const ctx = {
    forwardingScore: 9,
    isForwarded: false,
  };
  if (config.channel?.id) {
    ctx.forwardedNewsletterMessageInfo = {
      newsletterJid: config.channel.id,
      newsletterName: config.channel.name || config.bot?.name,
      serverMessageId: 127,
    };
  }
  return ctx;
}

/**
 * Build an `extendedTextMessage` shaped exactly like WhatsApp's own link
 * preview: the channel link first in `text`, echoed as `matchedText`, with a
 * `title`, `description` and a `jpegThumbnail` (base64 JPEG) so the bubble
 * renders the same big card as a normal rich preview. Tapping it opens
 * `config.channel.link`.
 *
 * @param {object}  opts
 * @param {string}  opts.text        full message text (link is prepended)
 * @param {string} [opts.title]
 * @param {string} [opts.description]
 * @param {Buffer} [opts.thumbnail]  any image; downscaled to JPEG
 */
export async function linkPreviewMessage({ text, title = "", description = "", thumbnail = null, link = null } = {}) {
  const url = link || config.channel?.link || "";
  if (!url) return { extendedTextMessage: { text: String(text || "") } };
  let jpegThumbnail;
  if (thumbnail) {
    try {
      const sharp = (await import("sharp")).default;
      const buf = await sharp(thumbnail).resize({ width: 720, height: 405, fit: "cover" }).jpeg({ quality: 70 }).toBuffer();
      jpegThumbnail = buf.toString("base64");
    } catch {
      /* no thumbnail — card still renders with title/description */
    }
  }
  return {
    extendedTextMessage: {
      text: `${url}\n${text || ""}`.trim(),
      matchedText: url,
      canonicalUrl: url,
      title: title || config.bot?.name || "",
      description: description || config.channel?.name || "",
      previewType: 0,
      ...(jpegThumbnail ? { jpegThumbnail } : {}),
    },
  };
}

/**
 * Send `text` as a channel link-preview card. Falls back to a plain text reply
 * when no channel link is configured or the relay fails. `options.thumbnail`
 * overrides the default `menu` asset banner.
 */
export async function sendLinkPreview(sock, m, { text, title, description, thumbnail, link, quoted } = {}) {
  const url = link || config.channel?.link || "";
  if (sock?.relayMessage && url) {
    let image = thumbnail;
    if (image === undefined) {
      try {
        const { getImageBuffer } = await import("./asset-manager.js");
        image = await getImageBuffer("menu", config.bot?.name || "VEA").catch(() => null);
      } catch {
        image = null;
      }
    }
    const preview = await linkPreviewMessage({ text, title, description, thumbnail: image, link: url });
    try {
      await sock.relayMessage(
        m.chat,
        { extendedTextMessage: { ...preview.extendedTextMessage, contextInfo: saluranCtx() } },
        { quoted: quoted === undefined ? m.raw : quoted },
      );
      return true;
    } catch {
      /* fall through to plain text */
    }
  }
  await m.reply(text, { keep: true });
  return false;
}
