/**
 * GX-ID — /quotelimit (owner)
 *
 * Max text length accepted by the quote card feature.
 */
import { getQuoteMaxChars, setQuoteMaxChars, QUOTE_MAX_CHARS_CEILING } from "../../lib/settings.js";

const pluginConfig = {
  name: "quotelimit",
  alias: ["setquotelimit"],
  category: "bot-config",
  description: "Atur panjang teks maksimum untuk fitur quote",
  usage: ".quotelimit <jumlah>",
  examples: [".quotelimit 100"],
  helpOnEmpty: false,
  permission: "owner",
  cooldown: 3,
  isEnabled: true,
};

async function handler(m, { config }) {
  const prefix = m.prefix || config.command?.prefix || ".";
  const arg = m.args?.[0];
  if (!arg) {
    return m.reply(`💬 *Quote Limit*: ${getQuoteMaxChars()} karakter\n\n> Usage: \`${prefix}quotelimit <jumlah>\` (maks ${QUOTE_MAX_CHARS_CEILING})`);
  }
  const chars = Number(arg);
  if (!Number.isFinite(chars) || chars <= 0 || chars > QUOTE_MAX_CHARS_CEILING) {
    return m.reply(`❌ Nilai tidak valid. Maksimum ${QUOTE_MAX_CHARS_CEILING}.`);
  }
  setQuoteMaxChars(Math.round(chars));
  await m.reply(`✅ Batas teks quote diatur ke *${Math.round(chars)}* karakter.`);
}

export { pluginConfig as config, handler };
