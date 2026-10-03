/**
 * GX-ID — /groupinfo
 */
import axios from "axios";
import { getParticipantJid, resolveAnyLidToJid } from "../../lib/lid.js";
import { fromTimestamp } from "../../lib/time.js";

const pluginConfig = {
  name: "groupinfo",
  alias: ["infogroup", "gcinfo", "infogc", "gc"],
  category: "group",
  description: "Show detailed group information",
  usage: ".groupinfo",
  example: ".groupinfo",
  isGroup: true,
  cooldown: 10,
  isEnabled: true,
};

function status(val) {
  return val === true || val === "on" ? "✅" : "❌";
}

async function handler(m, { sock, db }) {
  const meta = m.groupMetadata;
  const participants = meta.participants || [];
  const admins = participants.filter((p) => p.admin);

  let ownerJid = meta.owner ? resolveAnyLidToJid(meta.owner, participants) : null;
  if (!ownerJid || ownerJid.includes("@lid")) {
    const superAdmin = participants.find((p) => p.admin === "superadmin");
    if (superAdmin) ownerJid = getParticipantJid(superAdmin);
  }
  if (!ownerJid || ownerJid.includes("@lid")) {
    if (admins[0]) ownerJid = getParticipantJid(admins[0]);
  }

  const group = db.getGroup(m.chat) || {};
  const created = meta.creation ? fromTimestamp(meta.creation * 1000, "D MMMM YYYY") : "Unknown";
  const ownerNumber = ownerJid ? ownerJid.split("@")[0] : null;
  const ownerDisplay = ownerNumber && !ownerNumber.includes(":") ? `@${ownerNumber}` : "Unknown";
  const isOpen = meta.announce === false || !meta.announce;

  let text = `👥 *GROUP INFO*\n\n`;
  text += `Name    : *${meta.subject}*\n`;
  text += `ID      : ${m.chat}\n`;
  text += `Owner   : ${ownerDisplay}\n`;
  text += `Created : ${created}\n`;
  text += `Status  : ${isOpen ? "🔓 Open" : "🔒 Closed"}\n\n`;
  text += `📊 *MEMBERS*\n`;
  text += `Total : ${participants.length}\n`;
  text += `Admin : ${admins.length}\n`;
  text += `Member: ${participants.length - admins.length}\n\n`;
  text += `🔧 *FEATURES*\n`;
  text += `Welcome : ${status(group.welcome)}\n`;
  text += `Goodbye : ${status(group.goodbye)}\n`;
  text += `AntiLink: ${status(group.antilink)}\n`;
  text += `Mute    : ${status(group.mute)}`;

  if (meta.desc) text += `\n\n📝 *DESCRIPTION*\n${meta.desc}`;

  const mentions = ownerJid && !ownerJid.includes(":") ? [ownerJid] : [];

  let ppUrl = null;
  try {
    ppUrl = await sock.profilePictureUrl(m.chat, "image");
  } catch {
    /* no picture */
  }

  if (ppUrl) {
    try {
      const buffer = Buffer.from((await axios.get(ppUrl, { responseType: "arraybuffer", timeout: 10000 })).data);
      return sock.sendMessage(m.chat, { image: buffer, caption: text, mentions }, { quoted: m.raw });
    } catch {
      /* fall through */
    }
  }
  await m.reply(text, { mentions });
}

export { pluginConfig as config, handler };
