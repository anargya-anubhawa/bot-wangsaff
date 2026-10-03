/**
 * GX-ID — /report (all)
 *
 * Reports the replied-to (or mentioned) message to every management group
 * linked to this chat, with the sender, the preview and the media if any.
 */
import { numberFromJid } from "../../lib/group-utils.js";
import { detectMediaType, downloadMedia } from "../../lib/media.js";
import { logModerationEvent } from "../../lib/moderation-log.js";

const pluginConfig = {
  name: "report",
  alias: ["lapor", "reportmsg"],
  category: "utility",
  description: "Laporkan sebuah pesan ke grup manajemen yang terhubung",
  usage: ".report [alasan]",
  examples: [".report spam terus-menerus"],
  permission: "all",
  isGroup: true,
  cooldown: 10,
  isEnabled: true,
};

async function handler(m, { db, sock, config }) {
  const prefix = m.prefix || config.command?.prefix || ".";
  const quoted = m.quoted;
  if (!quoted) {
    return m.reply(`🚨 *Report*\n\n> Balas pesan yang ingin dilaporkan.\n> Contoh: \`${prefix}report spam\``);
  }

  const managementGroups = db.getManagementGroupsForTarget(m.chat);
  if (!managementGroups.length) {
    return m.reply("ℹ️ Grup ini belum punya grup manajemen yang terhubung, jadi laporan tidak bisa dikirim.");
  }

  const reporter = numberFromJid(m.sender);
  const offender = quoted.sender ? numberFromJid(quoted.sender) : "tidak diketahui";
  const reason = (m.text || "").trim() || "(tanpa alasan)";
  const preview = (quoted.body || quoted.text || "").slice(0, 200);

  const text =
    `🚨 *LAPORAN PESAN*\n\n` +
    `╭─〔 report 〕\n` +
    `┃ Pelapor   : @${reporter}\n` +
    `┃ Terlapor  : @${offender}\n` +
    `┃ Grup      : ${m.groupMetadata?.subject || m.chat.split("@")[0]}\n` +
    `┃ Alasan    : ${reason}\n` +
    `╰─⬣\n\n` +
    `> Pesan:\n${preview || "(media)"}`;

  const mentions = [m.sender, quoted.sender].filter(Boolean);
  const mediaType = detectMediaType(quoted);
  let buffer = null;
  if (mediaType) {
    try {
      buffer = await downloadMedia(quoted, sock);
    } catch {
      buffer = null;
    }
  }
  const forwardedMedia = buffer && mediaType ? { buffer, mediaType, mimetype: quoted.mimetype || "" } : null;

  for (const jid of managementGroups) {
    try {
      if (buffer && mediaType === "image") {
        await sock.sendMessage(jid, { image: buffer, caption: text, mentions }, { quoted: m.raw });
      } else {
        await sock.sendMessage(jid, { text, mentions });
      }
    } catch {
      /* continue with the remaining management groups */
    }
  }

  // Also record the report in the central event log (delivered to the group's
  // configured log panel when one is set — with the reported media forwarded).
  await logModerationEvent(
    {
      type: "moderation",
      action: "report",
      reason: "report",
      groupId: m.chat,
      actorId: m.sender,
      targetId: quoted.sender || null,
      messageId: quoted.id || null,
      contentPreview: preview,
      media: forwardedMedia,
      metadata: { detail: reason, reporter, offender },
    },
    sock,
  );

  await m.reply(`✅ Laporan terkirim ke ${managementGroups.length} grup manajemen.`);
}

export { pluginConfig as config, handler };
