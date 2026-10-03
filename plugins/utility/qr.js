/**
 * GX-ID — /qr
 *
 * Generate a QR code image from text.
 */
import QRCode from "qrcode";

const pluginConfig = {
  name: "qr",
  alias: ["qrcode", "qrgen", "qrgenerate"],
  category: "utility",
  description: "Generate a QR code from text",
  usage: ".qr <text>",
  example: ".qr https://example.com",
  isOwner: false,
  isGroup: false,
  cooldown: 5,
  isEnabled: true,
};

async function handler(m, { sock, config }) {
  const prefix = m.prefix || config.command?.prefix || ".";
  const text = m.text?.trim() || m.quoted?.body;
  if (!text) return m.reply(`🔳 *QR Code*\n\n> Usage: \`${prefix}qr <text>\``);

  await m.react("🕕");
  try {
    const buffer = await QRCode.toBuffer(text, {
      type: "png",
      width: 512,
      margin: 2,
      color: { dark: "#000000", light: "#ffffff" },
    });
    await sock.sendMessage(
      m.chat,
      { image: buffer, caption: `🔳 *QR Code*\n\n> ${text}` },
      { quoted: m.raw },
    );
    await m.react("✅");
  } catch (error) {
    await m.react("☢");
    throw error;
  }
}

export { pluginConfig as config, handler };
