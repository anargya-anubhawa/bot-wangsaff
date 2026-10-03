/**
 * GX-ID — /sticker (alias /s)
 *
 * Convert an image/video (or a quoted image/video, or a URL) into a WhatsApp
 * sticker with EXIF metadata.
 */
const pluginConfig = {
  name: "sticker",
  alias: ["s", "stiker", "stikerin"],
  category: "sticker",
  description: "Convert media into a sticker",
  usage: ".sticker (reply to an image/video or send with caption)",
  example: ".sticker",
  isOwner: false,
  isGroup: false,
  isPrivate: false,
  cooldown: 5,
  isEnabled: true,
};

async function handler(m, { sock, config }) {
  const prefix = m.prefix || config.command?.prefix || ".";
  const packname = m.args[0] || config.sticker?.packname || "GX-ID";
  const author = m.args[1] || config.sticker?.author || "GX-ID";

  let media = null;
  let isVideo = false;

  if (m.isImage || m.isVideo) {
    media = m;
    isVideo = m.isVideo;
  } else if (m.quoted && (m.quoted.isImage || m.quoted.isVideo || m.quoted.isSticker)) {
    media = m.quoted;
    isVideo = m.quoted.isVideo;
  }

  if (!media) {
    return m.reply(
      `🖼️ *Sticker*\n\n> Reply to an image/video or send one with the caption \`${prefix}sticker\``,
    );
  }

  await m.react("🕕");

  try {
    const buffer = await media.download();
    if (!buffer) throw new Error("Failed to download media");

    const sticker = isVideo
      ? await sock.sendVideoAsSticker(m.chat, buffer, m.raw, { packname, author })
      : await sock.sendImageAsSticker(m.chat, buffer, m.raw, { packname, author });

    await m.react("✅");
    return sticker;
  } catch (error) {
    await m.react("☢");
    throw error;
  }
}

export { pluginConfig as config, handler };
