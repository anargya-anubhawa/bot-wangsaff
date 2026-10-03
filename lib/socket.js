/**
 * GX-ID — socket extension
 *
 * Adds convenience helpers on top of the Baileys socket (sticker sending,
 * generic media/file sending, mention parsing, name resolution) mirroring the
 * reference architecture's `extendSocket`, trimmed to the features GX-ID
 * ships and adapted to upstream @whiskeysockets/baileys v7.
 */
import fs from "fs";
import path from "path";
import axios from "axios";
import mime from "mime-types";
import {
  prepareWAMessageMedia,
  generateWAMessageFromContent,
  downloadMediaMessage,
  getContentType,
  areJidsSameUser,
  isJidGroup,
  generateMessageIDV2,
} from "@whiskeysockets/baileys";
import { logger } from "./logger.js";
import {
  createStickerFromImage,
  createStickerFromVideo,
  DEFAULT_METADATA,
} from "./sticker.js";
import {
  isLid,
  isLidConverted,
  getCachedJid,
  resolveAnyLidToJid,
} from "./lid.js";
import { interactiveContextInfo } from "./context.js";
import { recordSent } from "./sent-tracker.js";
import config from "../config.js";

/* ─────────────────────────────── helpers ─────────────────────────────── */

async function downloadBuffer(url, timeout = 60000) {
  const res = await axios.get(url, {
    responseType: "arraybuffer",
    timeout,
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) GX-ID" },
  });
  return Buffer.from(res.data);
}

async function resolveInput(input) {
  if (Buffer.isBuffer(input)) return input;
  if (typeof input === "string") {
    if (/^https?:\/\//i.test(input)) return downloadBuffer(input);
    if (fs.existsSync(input)) return fs.readFileSync(input);
  }
  throw new Error("Invalid input: expected Buffer, URL, or file path");
}

/**
 * Binary nodes WhatsApp requires for interactive (native-flow) messages.
 *
 * Upstream Baileys v7 does not add these automatically, so an interactive
 * stanza sent without them is *silently dropped* by the server — the classic
 * "the bot shows typing… and then nothing arrives" symptom. Private chats also
 * need a `bot` node for the client to render native-flow buttons.
 */
export function interactiveRelayNodes(jid) {
  const nodes = [
    {
      tag: "biz",
      attrs: {},
      content: [
        {
          tag: "interactive",
          attrs: { type: "native_flow", v: "1" },
          content: [{ tag: "native_flow", attrs: { v: "9", name: "mixed" } }],
        },
      ],
    },
  ];
  if (jid && !isJidGroup(jid)) nodes.push({ tag: "bot", attrs: { biz_bot: "1" } });
  return nodes;
}

/* ─────────────────────────── socket extension ─────────────────────────── */

export function extendSocket(sock) {
  const originalSendMessage = sock.sendMessage.bind(sock);

  /**
   * Wrap sendMessage so transient private-session errors trigger a re-key
   * attempt instead of failing outright (mirrors the reference behaviour).
   */
  sock.sendMessage = async (jid, content, options) => {
    try {
      const result = await originalSendMessage(jid, content, options);
      // Track our own sends so `.purge` can later revoke them.
      if (result?.key?.id) recordSent(jid, result.key);
      return result;
    } catch (err) {
      const isPrivate =
        jid && !jid.endsWith("@g.us") && !jid.endsWith("@broadcast") && !jid.endsWith("@newsletter");
      const isSessionError =
        err?.message?.includes("encrypt") ||
        err?.message?.includes("session") ||
        err?.message?.includes("pkmsg") ||
        err?.message?.includes("No Signal") ||
        err?.output?.statusCode === 500;
      if (isPrivate && isSessionError) {
        try {
          if (sock.assertSessions) await sock.assertSessions([jid], true);
          if (sock.uploadPreKeys) await sock.uploadPreKeys(5);
          const retried = await originalSendMessage(jid, content, options);
          if (retried?.key?.id) recordSent(jid, retried.key);
          return retried;
        } catch {
          throw err;
        }
      }
      throw err;
    }
  };

  sock.sendImageAsSticker = async (jid, input, m, options = {}) => {
    const buffer = await resolveInput(input);
    const sticker = await createStickerFromImage(buffer, {
      packname: options.packname ?? config.sticker?.packname ?? DEFAULT_METADATA.packname,
      author: options.author ?? config.sticker?.author ?? DEFAULT_METADATA.author,
      emojis: options.emojis || DEFAULT_METADATA.emojis,
    });
    return sock.sendMessage(
      jid,
      { sticker, contextInfo: { isForwarded: true, forwardingScore: 1 } },
      { quoted: m },
    );
  };

  sock.sendVideoAsSticker = async (jid, input, m, options = {}) => {
    const buffer = await resolveInput(input);
    const sticker = await createStickerFromVideo(buffer, {
      packname: options.packname ?? config.sticker?.packname ?? DEFAULT_METADATA.packname,
      author: options.author ?? config.sticker?.author ?? DEFAULT_METADATA.author,
      emojis: options.emojis || DEFAULT_METADATA.emojis,
      duration: options.duration,
      fps: options.fps,
    });
    return sock.sendMessage(
      jid,
      { sticker, contextInfo: { isForwarded: true, forwardingScore: 1 } },
      { quoted: m },
    );
  };

  sock.sendText = async (jid, text, quoted, options = {}) =>
    sock.sendMessage(jid, { text, ...options }, { quoted });

  sock.sendMedia = async function (jid, source, caption = "", quoted, options = {}) {
    if (source && typeof source === "object" && (source.image || source.video || source.audio || source.document)) {
      return sock.sendMessage(jid, source, { quoted, ...options });
    }
    let data = source;
    let mimetype = options.mimetype || "application/octet-stream";
    let fileName = options.fileName || "file";

    if (Buffer.isBuffer(source)) {
      /* already a buffer */
    } else if (typeof source === "string" && /^https?:\/\//i.test(source)) {
      data = { url: source };
    } else if (typeof source === "string" && fs.existsSync(source)) {
      mimetype = mime.lookup(source) || "application/octet-stream";
      fileName = path.basename(source);
      data = fs.readFileSync(source);
    } else if (source && typeof source === "object" && typeof source.url === "string") {
      data = { url: source.url };
    } else {
      throw new Error("Invalid source: expected Buffer, URL, file path, or { url }");
    }

    const mediaType = options.type || options.mediaType;
    const captionField = caption != null ? { caption } : {};
    const extra = { ...options };
    delete extra.type;
    delete extra.mediaType;

    let payload;
    if (mediaType === "image") payload = { image: data, ...captionField, ...extra };
    else if (mediaType === "video") payload = { video: data, ...captionField, ...extra };
    else if (mediaType === "audio") {
      payload = {
        audio: data,
        mimetype: mimetype !== "application/octet-stream" ? mimetype : "audio/mpeg",
        ptt: options.ptt || false,
        ...extra,
      };
    } else {
      payload = { document: data, mimetype, fileName, ...captionField, ...extra };
    }
    return sock.sendMessage(jid, payload, { quoted });
  };

  sock.sendFile = async (jid, input, options = {}) => {
    let buffer;
    let filename = options.filename || "file";
    let mimetype = options.mimetype;
    if (Buffer.isBuffer(input)) buffer = input;
    else if (typeof input === "string") {
      if (/^https?:\/\//i.test(input)) {
        buffer = await downloadBuffer(input);
        filename = options.filename || path.basename(new URL(input).pathname) || "file";
      } else if (fs.existsSync(input)) {
        buffer = fs.readFileSync(input);
        filename = options.filename || path.basename(input);
      } else throw new Error("Invalid input");
    } else throw new Error("Invalid input type");

    if (!mimetype) {
      const ext = path.extname(filename).toLowerCase();
      const map = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".mp4": "video/mp4",
        ".mp3": "audio/mpeg",
        ".ogg": "audio/ogg",
        ".pdf": "application/pdf",
        ".zip": "application/zip",
        ".txt": "text/plain",
        ".json": "application/json",
      };
      mimetype = map[ext] || "application/octet-stream";
    }

    const mc = {};
    if (mimetype.startsWith("image/")) {
      mc.image = buffer;
      if (options.caption) mc.caption = options.caption;
    } else if (mimetype.startsWith("video/")) {
      mc.video = buffer;
      mc.mimetype = mimetype;
      if (options.caption) mc.caption = options.caption;
    } else if (mimetype.startsWith("audio/")) {
      mc.audio = buffer;
      mc.mimetype = mimetype;
      mc.ptt = options.ptt || false;
    } else {
      mc.document = buffer;
      mc.mimetype = mimetype;
      mc.fileName = filename;
      if (options.caption) mc.caption = options.caption;
    }
    return sock.sendMessage(jid, mc, { quoted: options.quoted });
  };

  sock.sendContact = async (jid, contacts, options = {}) => {
    const list = Array.isArray(contacts) ? contacts : [contacts];
    const vcards = list.map((c) => {
      const name = c.name || "Unknown";
      const number = (c.number || "").replace(/[^0-9]/g, "");
      const org = c.org ? `ORG:${c.org}\n` : "";
      const vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${name}\n${org}TEL;type=CELL;type=VOICE;waid=${number}:+${number}\nEND:VCARD`;
      return { vcard };
    });
    const displayName = list.length === 1 ? list[0].name || "Contact" : `${list.length} Contacts`;
    return sock.sendMessage(jid, { contacts: { displayName, contacts: vcards } }, { quoted: options.quoted });
  };

  sock.sendButton = async (jid, text, buttons = [], quoted, options = {}) => {
    /* Upstream Baileys v7 does not accept interactiveButtons via sendMessage.
       Interactive menus are built by plugins using relayMessage directly. */
    return sock.sendMessage(
      jid,
      { text, footer: options.footer || config.bot?.name || "GX-ID", ...options.extra },
      { quoted },
    );
  };

  sock.parseMention = (text = "") =>
    [...String(text).matchAll(/@([0-9]{5,16}|0)/g)].map((v) => `${v[1]}@s.whatsapp.net`);

  sock.reply = (jid, text = "", quoted, options = {}) => {
    if (Buffer.isBuffer(text)) return sock.sendMessage(jid, { document: text, ...options }, { quoted });
    return sock.sendMessage(
      jid,
      { ...options, text, mentions: options.mentions || sock.parseMention(text) },
      { quoted },
    );
  };

  sock.downloadAndSaveMediaMessage = async (msg, savePath = null) => {
    const message = msg.message || msg;
    const type = getContentType(message);
    if (!type) throw new Error("No media found in message");
    const buffer = await downloadMediaMessage(
      { message },
      "buffer",
      {},
      { logger, reuploadRequest: sock.updateMediaMessage },
    );
    let savedPath = null;
    if (savePath) {
      const dir = path.dirname(savePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(savePath, buffer);
      savedPath = savePath;
    }
    return { buffer, path: savedPath, type };
  };

  sock.getName = async (jid, groupJid = null) => {
    if (!jid) return "Unknown";
    let id = jid;
    if (isLid(id) || isLidConverted(id)) {
      const cached = getCachedJid(id);
      if (cached) id = cached;
      else if (groupJid) {
        try {
          const gm = await sock.groupMetadata(groupJid);
          id = resolveAnyLidToJid(id, gm.participants || []);
        } catch {
          id = id.replace("@lid", "@s.whatsapp.net");
        }
      } else id = id.replace("@lid", "@s.whatsapp.net");
    }

    if (id.endsWith("@g.us")) {
      try {
        let v = sock.store?.contacts?.[id] || {};
        if (!(v.name || v.subject)) v = await sock.groupMetadata(id).catch(() => ({}));
        return v.name || v.subject || id.split("@")[0];
      } catch {
        return id.split("@")[0];
      }
    }

    if (id === "0@s.whatsapp.net") return "WhatsApp";
    const botId = `${sock.user?.id?.split(":")[0]}@s.whatsapp.net`;
    if (id === botId) return sock.user?.name || sock.user?.verifiedName || "Bot";

    let v = sock.store?.contacts?.[id] || {};
    if (v.name) return v.name;
    if (v.notify) return v.notify;
    if (v.pushName) return v.pushName;
    if (v.verifiedName) return v.verifiedName;

    const number = id.replace(/@.+/g, "");
    if (number) {
      if (number.startsWith("62")) return `+62${number.slice(2)}`;
      return `+${number}`;
    }
    return "Unknown";
  };

  sock.getNameFromParticipants = (jid, participants = []) => {
    if (!jid) return "Unknown";
    let resolved = jid;
    if (isLid(jid) || isLidConverted(jid)) resolved = resolveAnyLidToJid(jid, participants);
    const targetNum = resolved.replace(/[^0-9]/g, "");
    const participant = (participants || []).find(
      (p) => (p.jid || p.id || "").replace(/[^0-9]/g, "") === targetNum,
    );
    if (participant) {
      const pJid = participant.jid || participant.id || "";
      const c = sock.store?.contacts?.[pJid];
      if (c?.name) return c.name;
      if (c?.notify) return c.notify;
    }
    const number = resolved.replace(/@.+/g, "");
    if (number.startsWith("62")) return `0${number.slice(2)}`;
    return number || "Unknown";
  };

  /**
   * Send a pre-built interactive message via relayMessage. Baileys v7 has no
   * sendMessage support for interactiveButtons, so plugins/menu use this.
   */
  sock.sendInteractive = async (jid, interactiveContent, options = {}) => {
    const msg = generateWAMessageFromContent(
      jid,
      {
        viewOnceMessage: {
          message: { messageContextInfo: interactiveContextInfo(), ...interactiveContent },
        },
      },
      { userJid: sock.user?.id, ...options },
    );
    await sock.relayMessage(jid, msg.message, {
      messageId: msg.key.id,
      additionalNodes: interactiveRelayNodes(jid),
    });
    return msg;
  };

  /* expose a couple of the media helpers for plugins */
  sock.prepareMedia = (media, opts = {}) =>
    prepareWAMessageMedia(media, { upload: sock.waUploadToServer, ...opts });

  /**
   * Send a link-preview style message (ported from the ourin Baileys fork used
   * by GX-ID). Builds an `extendedTextMessage` with a rich preview card and
   * relays it directly. Returns the generated message id.
   *
   * @param {string} jid
   * @param {{caption?:string,text?:string,url?:string,matchedText?:string,title?:string,description?:string,previewType?:number,image?:Buffer|string,jpegThumbnail?:Buffer,thumbnailWidth?:number,thumbnailHeight?:number,inviteLinkGroupTypeV2?:number}} preview
   * @param {{quoted?:object,contextInfo?:object}} options
   * @returns {Promise<string>} message id
   */
  sock.sendPreview = async (jid, preview = {}, options = {}) => {
    const extContent = {
      text: preview.caption || preview.text || "",
      matchedText: preview.matchedText || preview.url || "",
      previewType: preview.previewType ?? 0,
    };
    if (preview.title) extContent.title = preview.title;
    if (preview.description) extContent.description = preview.description;
    if (preview.inviteLinkGroupTypeV2)
      extContent.inviteLinkGroupTypeV2 = preview.inviteLinkGroupTypeV2;

    if (preview.image) {
      let imgBuf = preview.image;
      if (typeof imgBuf === "string" && imgBuf.startsWith("http")) {
        try {
          imgBuf = await downloadBuffer(imgBuf);
        } catch {
          /* keep the url string */
        }
      }
      if (Buffer.isBuffer(imgBuf)) {
        try {
          const { imageMessage } = await prepareWAMessageMedia(
            { image: imgBuf },
            { upload: sock.waUploadToServer, mediaTypeOverride: "thumbnail-link" },
          );
          if (imageMessage) {
            extContent.jpegThumbnail = imageMessage.jpegThumbnail;
            if (imageMessage.directPath)
              extContent.thumbnailDirectPath = imageMessage.directPath;
            if (imageMessage.mediaKey) extContent.mediaKey = imageMessage.mediaKey;
            if (imageMessage.mediaKeyTimestamp)
              extContent.mediaKeyTimestamp = imageMessage.mediaKeyTimestamp;
            if (imageMessage.fileSha256)
              extContent.thumbnailSha256 = imageMessage.fileSha256;
            if (imageMessage.fileEncSha256)
              extContent.thumbnailEncSha256 = imageMessage.fileEncSha256;
            if (imageMessage.width) extContent.thumbnailWidth = imageMessage.width;
            if (imageMessage.height) extContent.thumbnailHeight = imageMessage.height;
          }
        } catch {
          extContent.jpegThumbnail = imgBuf;
        }
      } else {
        extContent.jpegThumbnail = imgBuf;
      }
    } else if (preview.jpegThumbnail) {
      extContent.jpegThumbnail = preview.jpegThumbnail;
    }
    if (preview.thumbnailHeight) extContent.thumbnailHeight = preview.thumbnailHeight;
    if (preview.thumbnailWidth) extContent.thumbnailWidth = preview.thumbnailWidth;

    if (options.quoted) {
      const q = options.quoted;
      const participant = q.key?.fromMe
        ? sock.user?.id
        : q.participant || q.key?.participant || q.key?.remoteJid;
      extContent.contextInfo = {
        stanzaId: q.key?.id,
        participant,
        quotedMessage: q.message,
      };
    }
    if (options.contextInfo) {
      extContent.contextInfo = { ...extContent.contextInfo, ...options.contextInfo };
    }

    const messageId = generateMessageIDV2(sock.user?.id);
    await sock.relayMessage(jid, { extendedTextMessage: extContent }, { messageId });
    return messageId;
  };

  sock.areJidsSameUser = (a, b) => areJidsSameUser(a, b);

  return sock;
}
