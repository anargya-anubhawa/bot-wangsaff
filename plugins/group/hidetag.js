/**
 * GX-ID — /hidetag
 *
 * Sends a message that mentions everyone but shows no visible mention text.
 */
import { generateWAMessageFromContent } from "@whiskeysockets/baileys";
import { getParticipantJid } from "../../lib/lid.js";

const pluginConfig = {
  name: "hidetag",
  alias: ["ht", "h"],
  category: "group",
  description: "Mention everyone without showing the mentions",
  usage: ".hidetag <message>",
  example: ".hidetag (Good morning)",
  helpOnEmpty: false,
  isGroup: true,
  isAdmin: true,
  cooldown: 15,
  isEnabled: true,
};

async function handler(m, { sock }) {
  const hasQuoted = !!m.quoted;
  const rawText = (m.text || "").trim();
  const cleanText = rawText.replace(/^\(([\s\S]*)\)$/, "$1").trim();

  if (!hasQuoted && !cleanText) {
    return m.reply(`Provide text or reply to a message.\n\nExample: \`${m.prefix}hidetag (Good morning)\``);
  }

  const mentions = (m.groupMetadata?.participants || []).map((p) => getParticipantJid(p)).filter(Boolean);

  let messageContent;
  if (hasQuoted) {
    const quotedMsg = m.quoted.message || { conversation: m.quoted.body || "" };
    messageContent = JSON.parse(JSON.stringify(quotedMsg));
  } else {
    messageContent = { extendedTextMessage: { text: cleanText } };
  }

  const msg = generateWAMessageFromContent(m.chat, messageContent, {
    userJid: sock.user?.id,
    messageId: undefined,
  });

  const type = Object.keys(msg.message)[0];
  if (msg.message[type]) {
    msg.message[type].contextInfo = {
      ...(msg.message[type].contextInfo || {}),
      mentionedJid: mentions,
    };
  }

  await sock.relayMessage(m.chat, msg.message, { messageId: msg.key.id });
}

export { pluginConfig as config, handler };
