/**
 * GX-ID — /shorten
 *
 * Shorten a URL using the TinyURL API (no key required).
 */
import axios from "axios";

const pluginConfig = {
  name: "shorten",
  alias: ["shorturl", "tinyurl", "pendek"],
  category: "utility",
  description: "Shorten a long URL",
  usage: ".shorten <url>",
  example: ".shorten https://example.com/very/long/link",
  isOwner: false,
  isGroup: false,
  cooldown: 5,
  isEnabled: true,
};

async function handler(m, { config }) {
  const prefix = m.prefix || config.command?.prefix || ".";
  let url = m.text?.trim();
  if (!url && m.quoted?.body) url = m.quoted.body.trim();
  if (!url) return m.reply(`🔗 *Shorten URL*\n\n> Usage: \`${prefix}shorten <url>\``);

  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;

  await m.react("🕕");
  try {
    const res = await axios.get(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(url)}`, {
      timeout: 15000,
    });
    const short = String(res.data || "").trim();
    if (!short || !short.startsWith("http")) throw new Error("Invalid response");
    await m.reply(`🔗 *Shortened URL*\n\n> ${short}`);
    await m.react("✅");
  } catch (error) {
    await m.react("☢");
    throw error;
  }
}

export { pluginConfig as config, handler };
