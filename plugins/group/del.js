/**
 * GX-ID — /del (owner / whitelist / group admin)
 *
 * Deletes the message you reply to, then records the deletion in the event log
 * and forwards it — content AND media (image / video / audio / sticker /
 * document / text) — to the group's log panel.
 *
 *   .del   (reply to a message)  → hapus pesan itu + catat ke log panel
 *
 * The log destination follows the deleted-message log scope:
 *   - registered groups  → their `.log set` target, else the global default panel
 *   - public mode        → non-registered groups forward to the global panel
 *                          configured via `.log default`
 */
import { detectMediaType, downloadMedia, getMimetype } from "../../lib/media.js";
import { logModerationEvent, getExternalLogPanel } from "../../lib/moderation-log.js";
import { ensureBotAdmin, BOT_NOT_ADMIN } from "../../lib/plugin-utils.js";

const MAX_FORWARD_BYTES = 8 * 1024 * 1024;

const pluginConfig = {
  name: "del",
  alias: ["delete", "hapus"],
  category: "group",
  description: "Hapus pesan yang di-reply & teruskan ke log panel",
  usage: ".del (reply pesan)",
  examples: [".del"],
  permission: "admin",
  isGroup: true,
  cooldown: 3,
  isEnabled: true,
};

async function handler(m, { sock, config }) {
  const prefix = m.prefix || config.command?.prefix || ".";
  const quoted = m.quoted;

  if (!quoted) {
    return m.reply(
      `🗑️ *Delete*\n\n> Balas pesan yang ingin dihapus.\n> Contoh: \`${prefix}del\` (reply pesan)`,
    );
  }

  /* Deleting someone else's message requires the bot to be a group admin; the
     bot can always delete its own messages. */
  const isOwn = quoted.key?.fromMe || false;
  if (!isOwn && !(await ensureBotAdmin(m, sock))) {
    return m.reply(BOT_NOT_ADMIN);
  }

  /* Collect the deleted content (media included) BEFORE deleting it. */
  const media = await gatherMedia(quoted, m.chat, sock);

  /* Delete the replied message (best-effort). The trigger command is left in
     place so the user still sees the 🗑️ reaction as feedback. */
  let deleted = true;
  try {
    await sock.sendMessage(m.chat, { delete: quoted.key });
  } catch {
    deleted = false;
  }

  if (!deleted) {
    return m.reply("❌ Gagal menghapus pesan. Pastikan bot adalah admin grup.");
  }

  const mediaType = detectMediaType(quoted);
  await logModerationEvent(
    {
      type: "moderation",
      action: "delete",
      reason: "del",
      groupId: m.chat,
      actorId: m.sender,
      targetId: quoted.sender || null,
      messageId: quoted.id || null,
      contentPreview: quoted.body || quoted.text || (mediaType ? `(${mediaType})` : null),
      media,
      metadata: {
        detail: `dihapus oleh @${String(m.sender).split("@")[0]}`,
        mediaType: mediaType || null,
      },
    },
    sock,
  );

  m.react("🗑️");
}

/**
 * Download the replied message's media when there is an external panel to
 * forward it to. Best-effort and bounded so a huge file never stalls the bot.
 */
async function gatherMedia(quoted, chat, sock) {
  if (!getExternalLogPanel(chat)) return null;
  const mediaType = detectMediaType(quoted);
  if (!mediaType) return null;
  try {
    const buffer = await downloadMedia(quoted, sock);
    if (!buffer || buffer.length > MAX_FORWARD_BYTES) return null;
    return { buffer, mediaType, mimetype: getMimetype(quoted), fileName: quoted.fileName || "" };
  } catch {
    return null;
  }
}

export { pluginConfig as config, handler };
