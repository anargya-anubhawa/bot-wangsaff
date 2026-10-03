/**
 * GX-ID — /translate
 *
 * Translate text using the public Google Translate endpoint.
 */
import axios from "axios";

const pluginConfig = {
  name: "translate",
  alias: ["tr", "terjemah"],
  category: "utility",
  description: "Translate text to another language",
  usage: ".translate <lang> <text> (or reply to a message)",
  example: ".translate en Selamat pagi",
  isOwner: false,
  isGroup: false,
  cooldown: 5,
  isEnabled: true,
};

async function handler(m, { config }) {
  const prefix = m.prefix || config.command?.prefix || ".";
  const target = (m.args[0] || "").toLowerCase();

  if (!target) {
    return m.reply(
      `🌐 *Translate*\n\n> Usage: \`${prefix}translate <lang> <text>\`\n> Or reply to a message with \`${prefix}translate <lang>\``,
    );
  }

  let text = m.text.slice(m.args[0].length).trim();
  if (!text && m.quoted?.body) text = m.quoted.body;
  if (!text) return m.reply("❌ No text to translate.");

  await m.react("🕕");
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(
      target,
    )}&dt=t&q=${encodeURIComponent(text)}`;
    const res = await axios.get(url, { timeout: 20000 });
    const data = res.data;
    const translated = Array.isArray(data?.[0]) ? data[0].map((x) => x[0]).join("") : "";
    const detected = data?.[2] || "auto";
    if (!translated) throw new Error("No translation");
    await m.reply(`🌐 *Translate* (${detected} → ${target})\n\n> ${translated}`);
    await m.react("✅");
  } catch (error) {
    await m.react("☢");
    throw error;
  }
}

export { pluginConfig as config, handler };
