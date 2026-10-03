/**
 * GX-ID — /search
 *
 * Search the web via DuckDuckGo's instant-answer API (no key required).
 */
import axios from "axios";

const pluginConfig = {
  name: "search",
  alias: ["google", "duckduckgo", "ddg"],
  category: "search",
  description: "Search the web",
  usage: ".search <query>",
  example: ".search whatsapp baileys",
  isOwner: false,
  isGroup: false,
  cooldown: 5,
  isEnabled: true,
};

async function handler(m, { config }) {
  const prefix = m.prefix || config.command?.prefix || ".";
  const query = m.text?.trim();
  if (!query) return m.reply(`🔍 *Search*\n\n> Usage: \`${prefix}search <query>\``);

  await m.react("🕕");
  try {
    const res = await axios.get("https://api.duckduckgo.com/", {
      params: { q: query, format: "json", no_html: 1, skip_disambig: 1 },
      timeout: 20000,
    });
    const data = res.data || {};
    let text = `🔍 *Search:* ${query}\n\n`;

    if (data.AbstractText) {
      text += `📖 ${data.AbstractText}\n`;
      if (data.AbstractURL) text += `\n🔗 ${data.AbstractURL}`;
    } else if (data.RelatedTopics?.length) {
      const topics = data.RelatedTopics.filter((t) => t.Text).slice(0, 5);
      text += topics.map((t, i) => `${i + 1}. ${t.Text}${t.FirstURL ? `\n   🔗 ${t.FirstURL}` : ""}`).join("\n\n");
    } else {
      text += "No results found.";
    }

    await m.reply(text);
    await m.react("✅");
  } catch (error) {
    await m.react("☢");
    throw error;
  }
}

export { pluginConfig as config, handler };
