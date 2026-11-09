/**
 * GX-ID — /rvo (read view once)
 *
 * Replies with the media of a view-once message so it can be saved.
 *
 * Two independent settings (both owner-only, both global):
 *
 *   1. ACCESS — who may USE `.rvo`
 *        `.rvo owner`    → owner (or whitelist in a private chat) only
 *        `.rvo admin`    → owner, whitelist (PC) or a group admin
 *        `.rvo public`   → anyone (default)
 *
 *   2. DELIVERY — where the revealed media goes
 *        `.rvo default`  → in the same chat, right under the `.rvo` command
 *        `.rvo private`  → in a private chat with whoever ran `.rvo`
 *
 * The older enable/disable scope (`.log rvo registered|public`) still applies
 * on top: in `registered` mode `.rvo` only works inside registered groups.
 *
 * Running a bare `.rvo` (no argument) just opens the view-once message — it
 * never changes a setting, so a normal user can use the feature without ever
 * touching its configuration.
 */
import {
  getRvoScope,
  getRvoAccess,
  setRvoAccess,
  getRvoDelivery,
  setRvoDelivery,
  RVO_ACCESS,
  RVO_DELIVERY,
} from "../../lib/settings.js";
import { isRegisteredGroup, isOwner, isOwnerOrWhitelistedIn, isGroupAdmin } from "../../lib/access.js";
import { logModerationEvent, getExternalLogPanel } from "../../lib/moderation-log.js";
import { detectMediaType, getMimetype } from "../../lib/media.js";

const MAX_FORWARD_BYTES = 8 * 1024 * 1024;

const pluginConfig = {
  name: "rvo",
  alias: ["readviewonce", "readview"],
  category: "tools",
  description: "Baca pesan sekali lihat (view once)",
  usage: ".rvo [owner|admin|public|private|default]",
  example: ".rvo",
  isOwner: false,
  isPremium: false,
  isGroup: false,
  isPrivate: false,
  cooldown: 5,
  energi: 1,
  // A bare `.rvo` must OPEN the media, not print a usage card.
  helpOnEmpty: false,
  isEnabled: true,
};

const ACCESS_LABEL = { owner: "Owner", admin: "Admin grup", public: "Public (semua orang)" };
const DELIVERY_LABEL = { default: "Default (di chat yang sama)", private: "Private (PC peminta)" };

/**
 * Whether `m` may run `.rvo`, honouring the configured access tier.
 * Owner/whitelist always pass; `admin` additionally accepts group admins.
 *
 * @returns {boolean}
 */
export function canUseRvo(m) {
  const level = getRvoAccess();
  if (level === RVO_ACCESS.PUBLIC) return true;
  if (m.isOwner || m.fromMe) return true;
  if (isOwnerOrWhitelistedIn(m)) return true;
  if (level === RVO_ACCESS.ADMIN) return isGroupAdmin(m);
  return false;
}

/** The message shown when the access tier denies the requester. */
function accessDeniedMessage(prefix) {
  const level = getRvoAccess();
  if (level === RVO_ACCESS.ADMIN) {
    return `🔒 *\`.rvo\` hanya untuk admin grup.*\n\n> Owner bisa mengubahnya: \`${prefix}rvo public\`.`;
  }
  return `🔒 *\`.rvo\` hanya untuk owner.*\n\n> Owner bisa mengubahnya: \`${prefix}rvo admin\` atau \`${prefix}rvo public\`.`;
}

/**
 * Handle a configuration sub-command. Owner-only, and deliberately checked
 * here rather than via `pluginConfig.permission` so that ordinary users can
 * still run a bare `.rvo` when the access tier allows it.
 *
 * @returns {Promise<boolean>} `true` when the argument was a config command
 */
async function handleConfig(m, arg, prefix) {
  const value = String(arg || "").toLowerCase();
  const isAccess = ["owner", "admin", "public"].includes(value);
  const isDelivery = ["private", "default"].includes(value);
  if (!isAccess && !isDelivery) return false;

  /* Only the owner (or a whitelisted number in a private chat) may reconfigure. */
  if (!isOwnerOrWhitelistedIn(m)) {
    await m.reply(`🔒 *Hanya owner* yang boleh mengubah setelan \`.rvo\`.`);
    return true;
  }

  if (isAccess) {
    setRvoAccess(value);
    await m.reply(`✅ *Akses \`.rvo\`* sekarang: *${ACCESS_LABEL[value]}*`);
    return true;
  }

  setRvoDelivery(value);
  await m.reply(
    value === RVO_DELIVERY.PRIVATE
      ? `✅ *Pengiriman \`.rvo\`* sekarang: *${DELIVERY_LABEL.private}*\n\n> Hasil dibuka dikirim ke PC orang yang mengetik \`.rvo\`.`
      : `✅ *Pengiriman \`.rvo\`* sekarang: *${DELIVERY_LABEL.default}*\n\n> Hasil dibuka dikirim di chat yang sama, di bawah perintah \`.rvo\`.`,
  );
  return true;
}

/** Show the current configuration (owner, `.rvo status`). */
async function showStatus(m, prefix) {
  const access = getRvoAccess();
  const delivery = getRvoDelivery();
  await m.reply(
    `👁️ *Setelan RVO*\n\n` +
      `> Akses     : *${ACCESS_LABEL[access]}*\n` +
      `> Pengiriman: *${DELIVERY_LABEL[delivery]}*\n` +
      `> Scope     : *${getRvoScope().toUpperCase()}*\n\n` +
      `> \`${prefix}rvo owner\` — hanya owner\n` +
      `> \`${prefix}rvo admin\` — admin grup & owner\n` +
      `> \`${prefix}rvo public\` — semua orang\n` +
      `> \`${prefix}rvo private\` — hasil dikirim ke PC peminta\n` +
      `> \`${prefix}rvo default\` — hasil dikirim di chat ini\n\n` +
      `> Reply pesan view once dengan \`${prefix}rvo\` untuk membukanya.`,
  );
}

async function handler(m, { sock, config }) {
  const prefix = m.prefix || config.command?.prefix || ".";
  const arg = (m.args || [])[0];

  /* Configuration first — it is owner-gated inside handleConfig, so an
     ordinary user reaching here with "public" is told to ask the owner. */
  if (String(arg || "").toLowerCase() === "status") {
    if (!isOwnerOrWhitelistedIn(m)) {
      return m.reply(`🔒 *Hanya owner* yang boleh melihat setelan \`.rvo\`.`);
    }
    return showStatus(m, prefix);
  }
  if (await handleConfig(m, arg, prefix)) return;

  /* Access gate — who may use the feature at all. */
  if (!canUseRvo(m)) return m.reply(accessDeniedMessage(prefix));

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
      `Reply pesan sekali lihat (view once) untuk membukanya.\n\n\`Contoh: ${prefix}rvo\` (reply pesan view once)`,
    );
  }

  if (!quoted.isViewOnce && !quoted.isMedia) {
    return m.reply("❌ Reply pesan view once (sekali lihat) untuk membukanya.");
  }

  m.react("⏱️");

  /* Delivery target: the current chat (default) or a private chat with the
     requester. Private mode is meaningless when the command was already run in
     a private chat, so it falls back to the current chat. */
  const privateMode = getRvoDelivery() === RVO_DELIVERY.PRIVATE && m.isGroup && !!m.sender;
  const target = privateMode ? m.sender : m.chat;
  /* Quote the triggering message only where it is visible to the recipient. */
  const sendOptions = privateMode ? undefined : { quoted: m };

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
    /* In private mode the recipient no longer sees the source chat, so the
       origin is spelled out. */
    const privateCaption = privateMode
      ? `👁️ *View Once*${m.pushName ? `\n\`Dari :\` ${m.pushName}` : ""}${caption ? `\n\n${caption}` : ""}`
      : caption;

    if (quoted.isImage) {
      await sock.sendMessage(target, { image: buffer, caption: privateCaption }, sendOptions);
    } else if (quoted.isVideo) {
      await sock.sendMessage(target, { video: buffer, caption: privateCaption }, sendOptions);
    } else if (quoted.isAudio) {
      await sock.sendMessage(
        target,
        {
          audio: buffer,
          mimetype: quoted.message?.[quoted.type]?.mimetype || "audio/mpeg",
        },
        sendOptions,
      );
    } else {
      const ext = quoted.type?.replace("Message", "") || "bin";
      await sock.sendMessage(
        target,
        {
          document: buffer,
          fileName: `rvo_${Date.now()}.${ext}`,
          mimetype: quoted.message?.[quoted.type]?.mimetype || "application/octet-stream",
          caption: privateCaption || "📎 View once media",
        },
        sendOptions,
      );
    }

    m.react("✅");
    if (privateMode) await m.reply("📩 Hasil view once dikirim ke PC kamu.").catch(() => {});

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
