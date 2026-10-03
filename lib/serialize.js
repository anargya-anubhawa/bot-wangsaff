/**
 * GX-ID — message serializer
 *
 * Turns a raw Baileys message into a rich `m` object with parsed command
 * info, media flags, group metadata, quoted-message helpers and reply
 * shortcuts. This mirrors the reference architecture's serializer while
 * staying trimmed to the features GX-ID actually ships.
 */
import {
  downloadContentFromMessage,
  getContentType,
  jidDecode,
  normalizeMessageContent,
} from "@whiskeysockets/baileys";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import axios from "axios";
import config, { isOwner, isBanned, isPremium, isPartner } from "../config.js";
import { getDatabase } from "./database.js";
import { saluranCtx } from "./context.js";
import { getGroupMetadataCached } from "./group-cache.js";
import {
  isLid,
  lidToJid,
  convertLidArray,
  decodeAndNormalize,
  resolveAnyLidToJid,
  getCachedJid,
  cacheParticipantLids,
  cacheLidJid,
  resolveFromSock,
} from "./lid.js";

/* ─────────────────────────────── prefix cache ─────────────────────────────── */

let _prefixCache = null;
let _prefixCacheTime = 0;
const PREFIX_CACHE_TTL = 30000;

export function getPrefixList() {
  const now = Date.now();
  if (_prefixCache && now - _prefixCacheTime < PREFIX_CACHE_TTL) return _prefixCache;
  const configPrefix = config.command?.prefix || ".";
  const extra = [];
  try {
    const db = getDatabase();
    const list = db.setting("prefixes");
    if (Array.isArray(list)) extra.push(...list);
  } catch {
    /* database not ready */
  }
  _prefixCache = [...new Set([configPrefix, ...extra].filter(Boolean))];
  _prefixCacheTime = now;
  return _prefixCache;
}

export function invalidatePrefixCache() {
  _prefixCache = null;
  _prefixCacheTime = 0;
}

/* ─────────────────────────────── helpers ─────────────────────────────── */

export function decodeJid(jid) {
  if (!jid) return null;
  if (/:\d+@/gi.test(jid)) {
    const decoded = jidDecode(jid) || {};
    return (decoded.user && decoded.server && `${decoded.user}@${decoded.server}`) || jid;
  }
  return jid;
}

export function getMessageType(message) {
  if (!message) return null;
  const contentType = getContentType(message);
  if (contentType === "messageContextInfo" && message.interactiveResponseMessage) {
    return "interactiveResponseMessage";
  }
  return contentType;
}

export function getMessageBody(message, type) {
  if (!message || !type) return "";
  const content = message[type];
  if (!content) return "";

  switch (type) {
    case "conversation":
      return message.conversation || "";
    case "extendedTextMessage":
      return content.text || "";
    case "imageMessage":
    case "videoMessage":
    case "documentMessage":
      return content.caption || "";
    case "buttonsResponseMessage":
      return content.selectedButtonId || "";
    case "listResponseMessage":
      return content.singleSelectReply?.selectedRowId || "";
    case "templateButtonReplyMessage":
      return content.selectedId || "";
    case "interactiveResponseMessage": {
      try {
        const paramsJson = content.nativeFlowResponseMessage?.paramsJson || "{}";
        const parsed = JSON.parse(paramsJson);
        if (parsed.id) return parsed.id;
        if (parsed.selectedRowId) return parsed.selectedRowId;
        if (parsed.response_json) {
          const nested = JSON.parse(parsed.response_json);
          if (nested.id) return nested.id;
          if (nested.selectedRowId) return nested.selectedRowId;
        }
        return "";
      } catch {
        return "";
      }
    }
    case "pollCreationMessage":
    case "pollCreationMessageV2":
    case "pollCreationMessageV3":
      return content.name || "";
    default:
      return "";
  }
}

/**
 * Parse a command from a message body. Supports multi-prefix (config prefix +
 * any prefixes stored in the database). Does NOT treat `#note` as a prefix —
 * note lookup is handled separately by the message pipeline.
 */
export function parseCommand(body) {
  const result = { isCommand: false, command: "", prefix: "", args: [], text: "", fullArgs: "" };
  if (!body) return result;

  const prefixList = getPrefixList();
  for (const p of prefixList) {
    if (body.startsWith(p)) {
      result.isCommand = true;
      result.prefix = p;
      const withoutPrefix = body.slice(p.length).trim();
      const parts = withoutPrefix.split(/\s+/);
      result.command = config.command?.caseSensitive ? parts[0] : parts[0].toLowerCase();
      result.args = parts.slice(1);
      result.text = withoutPrefix.slice(result.command.length).trim();
      result.fullArgs = result.text;
      return result;
    }
  }
  return result;
}

/* ─────────────────────────── quoted messages ─────────────────────────── */

async function serializeQuotedMessage(message, type, sock, participants = []) {
  if (!message || !type) return null;
  const messageContent = message[type];
  if (!messageContent) return null;
  const contextInfo = messageContent.contextInfo;
  if (!contextInfo || !contextInfo.quotedMessage) return null;

  const rawQuoted = contextInfo.quotedMessage;
  const quotedMessage = normalizeMessageContent(rawQuoted) || rawQuoted;
  const quotedType = getMessageType(quotedMessage);
  const isViewOnce = !!(
    rawQuoted?.viewOnceMessage ||
    rawQuoted?.viewOnceMessageV2 ||
    rawQuoted?.viewOnceMessageV2Extension
  );

  let quotedParticipant = contextInfo.participant || "";
  if (isLid(quotedParticipant)) {
    const cached = getCachedJid(quotedParticipant);
    if (cached && !isLid(cached)) quotedParticipant = cached;
    else if (participants.length) quotedParticipant = resolveAnyLidToJid(quotedParticipant, participants);
    else quotedParticipant = lidToJid(quotedParticipant);
  }
  quotedParticipant = decodeJid(quotedParticipant);

  const quoted = {
    pushName: "~ User",
    key: {
      remoteJid: message.key?.remoteJid || "",
      fromMe: quotedParticipant === decodeJid(sock?.user?.id),
      id: contextInfo.stanzaId || "",
      participant: quotedParticipant,
    },
    id: contextInfo.stanzaId || "",
    sender: quotedParticipant,
    senderNumber: (quotedParticipant || "").replace(/@.+/g, ""),
    type: quotedType,
    body: getMessageBody(quotedMessage, quotedType),
    message: quotedMessage,
    mentionedJid: convertLidArray(contextInfo.mentionedJid || [], participants),
    isMedia: ["imageMessage", "videoMessage", "audioMessage", "stickerMessage", "documentMessage"].includes(quotedType),
    isImage: quotedType === "imageMessage",
    isVideo: quotedType === "videoMessage",
    isAudio: quotedType === "audioMessage",
    isSticker: quotedType === "stickerMessage",
    isDocument: quotedType === "documentMessage",
    isViewOnce,
    mimetype: quotedMessage[quotedType]?.mimetype || "",
    fileName: quotedMessage[quotedType]?.fileName || "",
    fileLength: quotedMessage[quotedType]?.fileLength || 0,
  };

  quoted.download = async (filename = null) => {
    if (!quoted.isMedia) return null;
    const stream = await downloadContentFromMessage(quotedMessage[quotedType], quotedType.replace("Message", ""));
    let buffer = Buffer.from([]);
    for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
    if (filename) {
      const tempDir = join(process.cwd(), "storage", "temp");
      if (!existsSync(tempDir)) mkdirSync(tempDir, { recursive: true });
      const filepath = join(tempDir, filename);
      writeFileSync(filepath, buffer);
      return filepath;
    }
    return buffer;
  };

  return quoted;
}

/* ─────────────────────────────── serializer ─────────────────────────────── */

export async function serialize(sock, msg) {
  if (!msg || !msg.message || !msg.key) return null;

  const m = {};
  m.key = msg.key;
  m.id = msg.key?.id || "";
  m.chat = decodeJid(msg.key?.remoteJid || "");
  m.fromMe = msg.key?.fromMe || false;
  m.isNewsletter = m.chat?.endsWith("@newsletter") || false;
  m.isGroup = m.chat?.endsWith("@g.us") || false;

  const remoteJidAlt = msg.key?.remoteJidAlt ? decodeAndNormalize(msg.key.remoteJidAlt) : null;
  const participantAlt = msg.key?.participantAlt ? decodeAndNormalize(msg.key.participantAlt) : null;

  if (!m.isGroup && !m.isNewsletter && isLid(m.chat)) {
    if (remoteJidAlt && !isLid(remoteJidAlt)) {
      cacheLidJid(m.chat, remoteJidAlt);
      m.chat = remoteJidAlt;
    } else {
      const resolved = resolveAnyLidToJid(m.chat, []);
      if (resolved && !isLid(resolved)) m.chat = resolved;
      else if (m.fromMe) m.chat = decodeAndNormalize(sock.user.id);
    }
    m.key.remoteJid = m.chat;
  }

  let senderJid;
  if (m.isNewsletter) senderJid = sock.user.id;
  else if (m.isGroup) senderJid = msg.key.participant;
  else senderJid = m.fromMe ? sock.user.id : m.chat;
  senderJid = decodeAndNormalize(senderJid);

  if (!senderJid || isLid(senderJid)) {
    const altJid = m.isGroup ? participantAlt : remoteJidAlt;
    if (altJid && !isLid(altJid)) {
      if (senderJid) cacheLidJid(senderJid, altJid);
      senderJid = altJid;
    } else if (msg.participantPn) {
      senderJid = msg.participantPn;
    } else if (m.isGroup) {
      const resolved = await resolveFromSock(senderJid, sock);
      if (resolved && !isLid(resolved)) senderJid = resolved;
      else {
        try {
          const metadata = await getGroupMetadataCached(sock, m.chat);
          cacheParticipantLids(metadata?.participants || []);
          senderJid = resolveAnyLidToJid(senderJid || msg.key.participant, metadata?.participants || []);
        } catch {
          senderJid = resolveAnyLidToJid(senderJid || msg.key.participant, []);
        }
      }
    } else {
      const cached = resolveAnyLidToJid(senderJid || m.chat, []);
      senderJid = cached && !isLid(cached) ? cached : await resolveFromSock(senderJid || m.chat, sock);
    }
  }
  m.sender = senderJid;
  m.senderNumber = m.sender ? m.sender.replace(/@.+/g, "") : "";
  if (m.isGroup && m.sender) m.key.participant = m.sender;

  let dbContacts = {};
  try {
    dbContacts = getDatabase().setting("contacts") || {};
  } catch {
    /* ignore */
  }
  let pushName = msg.pushName || (m.isNewsletter ? "Channel" : "Unknown");
  if ((pushName === "Unknown" || pushName === "~ User") && dbContacts[m.sender]) {
    pushName = dbContacts[m.sender].name;
  }
  m.pushName = pushName;

  m.isBot = m.fromMe;
  m.isOwner = m.isNewsletter || m.fromMe ? true : isOwner(m.sender);
  m.isBanned = m.isNewsletter || m.fromMe ? false : isBanned(m.sender);
  m.isPremium = m.isNewsletter || m.fromMe ? true : isPremium(m.sender);
  m.isPartner = m.isNewsletter || m.fromMe ? true : isPartner(m.sender);
  m.isPrems = m.isPremium;

  const messageData = normalizeMessageContent(msg.message);
  m.isViewOnce = !!(msg.message?.viewOnceMessage || msg.message?.viewOnceMessageV2 || msg.message?.viewOnceMessageV2Extension);
  m.type = getMessageType(messageData);
  m.message = messageData;
  m.body = getMessageBody(messageData, m.type);

  const parsed = parseCommand(m.body);
  m.isCommand = parsed.isCommand;
  m.command = parsed.command;
  m.prefix = parsed.prefix;
  m.args = parsed.args;
  m.text = parsed.text;
  m.fullArgs = parsed.fullArgs;

  m.isQuoted = false;
  m.quoted = null;
  m._pendingQuoted = { messageData, type: m.type };

  const messageContent = messageData?.[m.type];
  m.mentionedJid = convertLidArray(messageContent?.contextInfo?.mentionedJid || []);

  m.isMedia = ["imageMessage", "videoMessage", "audioMessage", "stickerMessage", "documentMessage"].includes(m.type);
  m.isImage = m.type === "imageMessage";
  m.isVideo = m.type === "videoMessage";
  m.isAudio = m.type === "audioMessage";
  m.isSticker = m.type === "stickerMessage";
  m.isDocument = m.type === "documentMessage";
  m.isContact = m.type === "contactMessage" || m.type === "contactsArrayMessage";
  m.isLocation = m.type === "locationMessage" || m.type === "liveLocationMessage";

  m.groupMetadata = null;
  m.isAdmin = false;
  m.isBotAdmin = false;
  m.groupName = "";
  m.groupMembers = [];
  m.groupAdmins = [];

  if (m.isGroup) {
    try {
      // Use the shared cache: this used to be a fresh network round-trip for
      // EVERY group message, which made the bot feel sluggish and could hang
      // entirely when WhatsApp was slow.
      m.groupMetadata = await getGroupMetadataCached(sock, m.chat);
      m.groupName = m.groupMetadata?.subject || "";
      m.groupMembers = m.groupMetadata?.participants || [];
      m.groupAdmins = m.groupMembers.filter((p) => p.admin).map((p) => p.jid || p.id || p.lid || "");

      const senderNum = m.sender?.split("@")[0].split(":")[0].replace(/[^0-9]/g, "") || "";
      const botNum = decodeJid(sock.user?.id)?.split("@")[0].split(":")[0].replace(/[^0-9]/g, "") || "";
      const numOf = (p) => {
        const pJid = p.jid || p.id || p.lid || "";
        if (isLid(pJid)) {
          const resolved = getCachedJid(pJid) || getCachedJid(p.lid || "");
          if (resolved) return resolved.split("@")[0].split(":")[0].replace(/[^0-9]/g, "");
        }
        return pJid.split("@")[0].split(":")[0].replace(/[^0-9]/g, "");
      };
      const matchNum = (p) => !!p.admin && numOf(p) === senderNum;
      const matchBot = (p) => !!p.admin && numOf(p) === botNum;
      m.isAdmin = m.groupMembers.some(matchNum);
      m.isBotAdmin = m.groupMembers.some(matchBot);
      cacheParticipantLids(m.groupMembers);
    } catch {
      /* group metadata unavailable */
    }
  }

  if (m._pendingQuoted) {
    const { messageData: md, type } = m._pendingQuoted;
    m.quoted = await serializeQuotedMessage(md, type, sock, m.groupMembers || []);
    if (m.quoted) m.isQuoted = true;
    delete m._pendingQuoted;
  }

  if (isLid(m.sender)) {
    m.sender = resolveAnyLidToJid(m.sender, m.groupMembers || []);
    m.senderNumber = m.sender ? m.sender.replace(/@.+/g, "") : "";
  }
  if (m.mentionedJid.length) m.mentionedJid = convertLidArray(m.mentionedJid, m.groupMembers || []);
  if (m.quoted && isLid(m.quoted.sender)) {
    m.quoted.sender = resolveAnyLidToJid(m.quoted.sender, m.groupMembers || []);
    m.quoted.senderNumber = m.quoted.sender.replace(/@.+/g, "");
    m.quoted.key.participant = m.quoted.sender;
  }

  m.remoteJid = m.chat;
  m.jid = m.chat;
  m.botNumber = decodeJid(sock.user?.id)?.replace(/@.+/g, "") || "";
  m.botJid = decodeJid(sock.user?.id) || "";
  m.botName = sock.user?.name || config.bot?.name || "GX-ID";
  m.isPrivate = !m.isGroup && !m.isNewsletter;
  m.mimetype = messageData?.[m.type]?.mimetype || "";
  m.fileName = messageData?.[m.type]?.fileName || "";
  m.seconds = messageData?.[m.type]?.seconds || 0;
  m.ptt = messageData?.[m.type]?.ptt || false;
  m.quotedBody = m.quoted?.body || "";
  m.quotedSender = m.quoted?.sender || "";
  m.quotedType = m.quoted?.type || "";
  m.timestamp = msg.messageTimestamp;
  m.raw = msg;

  const ensureResolved = async (jid) => {
    if (isLid(jid)) {
      const pn = await resolveFromSock(jid, sock);
      if (pn && !isLid(pn)) return pn;
    }
    return jid;
  };

  /* ─────────────────────────── reply helpers ─────────────────────────── */

  m.reply = async (text, options = {}) => {
    if (!text && text !== 0) return null;
    const contextInfo = { mentionedJid: options.mentions || [m.sender], ...options.contextInfo };
    return sock.sendMessage(
      await ensureResolved(m.chat),
      { text, contextInfo, ...options },
      { quoted: options.quoted !== false ? msg : undefined },
    );
  };

  m.replyWithMentions = async (text) => {
    const mentions = [...text.matchAll(/@(\d+)/g)].map((x) => `${x[1]}@s.whatsapp.net`);
    return m.reply(text, { mentions });
  };

  m.replyImage = async (image, caption = "", options = {}) => {
    let buffer = image;
    if (typeof image === "string" && image.startsWith("http")) {
      buffer = Buffer.from((await axios.get(image, { responseType: "arraybuffer" })).data);
    }
    return sock.sendMessage(
      await ensureResolved(m.chat),
      { image: buffer, caption, contextInfo: options.contextInfo, mentions: options.mentions || [] },
      { quoted: options.quoted !== false ? msg : undefined },
    );
  };

  m.replyVideo = async (video, caption = "", options = {}) => {
    let buffer = video;
    if (typeof video === "string" && video.startsWith("http")) {
      buffer = Buffer.from((await axios.get(video, { responseType: "arraybuffer" })).data);
    }
    return sock.sendMessage(
      await ensureResolved(m.chat),
      { video: buffer, caption, gifPlayback: options.gif || false, contextInfo: options.contextInfo, mentions: options.mentions || [] },
      { quoted: options.quoted !== false ? msg : undefined },
    );
  };

  m.replyAudio = async (audio, ptt = false, options = {}) => {
    let buffer = audio;
    if (typeof audio === "string" && audio.startsWith("http")) {
      buffer = Buffer.from((await axios.get(audio, { responseType: "arraybuffer" })).data);
    }
    return sock.sendMessage(
      await ensureResolved(m.chat),
      { audio: buffer, ptt, mimetype: "audio/mpeg" },
      { quoted: options.quoted !== false ? msg : undefined },
    );
  };

  m.replySticker = async (sticker, options = {}) => {
    let buffer = sticker;
    if (typeof sticker === "string" && sticker.startsWith("http")) {
      buffer = Buffer.from((await axios.get(sticker, { responseType: "arraybuffer" })).data);
    }
    return sock.sendMessage(await ensureResolved(m.chat), { sticker: buffer }, { quoted: options.quoted !== false ? msg : undefined });
  };

  m.replyDocument = async (doc, fileName, mimetype = "application/octet-stream", options = {}) => {
    let buffer = doc;
    if (typeof doc === "string" && doc.startsWith("http")) {
      buffer = Buffer.from((await axios.get(doc, { responseType: "arraybuffer" })).data);
    }
    return sock.sendMessage(
      await ensureResolved(m.chat),
      { document: buffer, fileName, mimetype, caption: options.caption || "" },
      { quoted: options.quoted !== false ? msg : undefined },
    );
  };

  m.replyWithPreview = async (text, options = {}) => {
    const ctx = { ...saluranCtx(), mentionedJid: options.mentions || [] };
    return sock.sendMessage(
      await ensureResolved(m.chat),
      { text, contextInfo: ctx },
      { quoted: options.quoted !== false ? msg : undefined },
    );
  };

  m.react = async (emoji) => {
    try {
      return await sock.sendMessage(await ensureResolved(m.chat), { react: { text: emoji, key: msg.key } });
    } catch {
      return null;
    }
  };

  m.download = async (filename = null) => {
    if (!m.isMedia) return null;
    const stream = await downloadContentFromMessage(messageData[m.type], m.type.replace("Message", ""));
    let buffer = Buffer.from([]);
    for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
    if (filename) {
      const tempDir = join(process.cwd(), "storage", "temp");
      if (!existsSync(tempDir)) mkdirSync(tempDir, { recursive: true });
      const filepath = join(tempDir, filename);
      writeFileSync(filepath, buffer);
      return filepath;
    }
    return buffer;
  };

  m.delete = async () => sock.sendMessage(m.chat, { delete: msg.key });

  m.forward = async (jid, forceForward = false) => sock.sendMessage(jid, { forward: msg, force: forceForward });

  return m;
}

export function getNumber(jid) {
  if (!jid) return "";
  return jid.replace(/@.+/g, "");
}

export function createJid(number) {
  if (!number) return "";
  return `${number.replace(/[^0-9]/g, "")}@s.whatsapp.net`;
}
