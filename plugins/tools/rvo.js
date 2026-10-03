/**
 * GX-ID — /rvo (read view once)
 *
 * Replies with the media of a view-once message so it can be saved. The feature
 * is scoped (`.log rvo <registered|public>`):
 *
 *   registered (default) — `.rvo` only works inside registered groups, and the
 *                          reveal is recorded in the log
 *   public               — `.rvo` works in every group
 */
import { getRvoScope } from "../../lib/settings.js";
import { isRegisteredGroup } from "../../lib/access.js";
import { logModerationEvent, getExternalLogPanel } from "../../lib/moderation-log.js";
import { detectMediaType, getMimetype } from "../../lib/media.js";

const MAX_FORWARD_BYTES = 8 * 1024 * 1024;

const pluginConfig = {
  name: "rvo",
  alias: ["readviewonce", "readview"],
  category: "tools",
  description: "Baca pesan sekali lihat (view once)",
  usage: ".rvo (reply pesan view once)",
  example: ".rvo",
  isOwner: false,
  isPremium: false,
  isGroup: false,
  isPrivate: false,
  cooldown: 5,
  energi: 1,
  isEnabled: true,
};

async function handler(m, { sock, config }) {
  const prefix = m.prefix || config.command?.prefix || ".";

  /* Scope gate: in `registered` mode `.rvo` is only allowed inside registered
     groups. Private chats are unaffected by the group scope. */
  if (m.isGroup && getRvoScope() !== "public" && !isRegisteredGroup(m.chat)) {
    return m.reply(
      `🔒 *\`.rvo\` hanya untuk grup terdaftar.*\n\n> Minta owner mengaktifkan mode public: \`${prefix}log rvo public\`.`,
    );
  }

  const quoted = m.quoted;
  if (!quoted) {
    return m.reply(
      `Reply pesan sekali lihat (view once) untuk membukanya.\n\n\`Contoh: ${m.prefix}rvo\` (reply pesan view once)`,
    );
  }

  if (!quoted.isViewOnce && !quoted.isMedia) {
    return m.reply("❌ Reply pesan view once (sekali lihat) untuk membukanya.");
  }

  m.react("⏱️");

  try {
    let originalCaption = "";
    if (quoted.message?.[quoted.type]?.caption) {
      originalCaption = quoted.message[quoted.type].caption;
    } else if (quoted.body) {
      originalCaption = quoted.body;
    }

    const buffer = await quoted.download();
    if (!buffer) throw new Error("Gagal download media");

    const caption = originalCaption ? `\`Pesan :\`\n> ${originalCaption}` : "";

    if (quoted.isImage) {
      await sock.sendMessage(
        m.chat,
        {
          image: buffer,
          caption,
        },
        { quoted: m },
      );
    } else if (quoted.isVideo) {
      await sock.sendMessage(
        m.chat,
        {
          video: buffer,
          caption,
        },
        { quoted: m },
      );
    } else if (quoted.isAudio) {
      await sock.sendMessage(
        m.chat,
        {
          audio: buffer,
          mimetype: quoted.message?.[quoted.type]?.mimetype || "audio/mpeg",
        },
        { quoted: m },
      );
    } else {
      const ext = quoted.type?.replace("Message", "") || "bin";
      await sock.sendMessage(
        m.chat,
        {
          document: buffer,
          fileName: `rvo_${Date.now()}.${ext}`,
          mimetype:
            quoted.message?.[quoted.type]?.mimetype ||
            "application/octet-stream",
          caption: caption || "📎 View once media",
        },
        { quoted: m },
      );
    }

    m.react("✅");

    if (m.isGroup) await logReveal(m, sock, quoted, buffer, originalCaption);
  } catch (e) {
    m.react("☢");
    let msg = e.message;
    if (
      msg.includes("Gagal download") ||
      msg.includes("decrypt") ||
      msg.includes("download") ||
      msg.includes("Timeout") ||
      msg.includes("404") ||
      msg.includes("Gone")
    ) {
      msg =
        "Media sudah kadaluarsa atau sudah dihapus dari server WhatsApp.\n\n_Pesan View Once yang terlalu lama atau sering dibuka biasanya akan otomatis hangus dari sistem WhatsApp dan tidak bisa diunduh lagi._";
    }
    m.reply(`❌ *Gagal Membuka View Once*\n\n> ${msg}`);
  }
}

/**
 * Record the reveal in the event log — the media itself is forwarded only when
 * the group has an external log panel (nothing to forward to otherwise).
 */
async function logReveal(m, sock, quoted, buffer, caption) {
  const mediaType = detectMediaType(quoted) || "document";
  let media = null;
  if (getExternalLogPanel(m.chat) && buffer && buffer.length <= MAX_FORWARD_BYTES) {
    media = { buffer, mediaType, mimetype: getMimetype(quoted), fileName: quoted.fileName || "" };
  }
  await logModerationEvent(
    {
      type: "moderation",
      action: "rvo",
      reason: "rvo",
      groupId: m.chat,
      actorId: m.sender,
      targetId: quoted.sender || null,
      messageId: quoted.id || null,
      contentPreview: caption || null,
      media,
      metadata: { detail: `dibuka oleh @${String(m.sender).split("@")[0]}`, mediaType },
    },
    sock,
  );
}

export { pluginConfig as config, handler };
