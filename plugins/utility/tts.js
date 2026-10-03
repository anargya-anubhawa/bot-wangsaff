/**
 * GX-ID — /tts
 *
 * Text-to-speech via Google Translate TTS, delivered as a voice note.
 */
import axios from "axios";

const pluginConfig = {
  name: "tts",
  alias: ["texttospeech", "say"],
  category: "utility",
  description: "Convert text to a voice note",
  usage: ".tts <language> <text>",
  example: ".tts id Halo semuanya",
  isOwner: false,
  isGroup: false,
  cooldown: 10,
  isEnabled: true,
};

const LANG_ALIASES = {
  id: "id", in: "id", indo: "id", indonesia: "id",
  en: "en", eng: "en", english: "en", inggris: "en",
  jp: "ja", ja: "ja", japan: "ja", jepang: "ja",
  kr: "ko", ko: "ko", korea: "ko",
  ar: "ar", arab: "ar",
  es: "es", spanyol: "es",
  fr: "fr", prancis: "fr",
  de: "de", jerman: "de",
  ru: "ru", th: "th", cn: "zh-CN", zh: "zh-CN",
};

async function handler(m, { sock, config }) {
  const prefix = m.prefix || config.command?.prefix || ".";
  let lang = "id";
  let text = m.text || "";

  const first = (m.args[0] || "").toLowerCase();
  if (first && LANG_ALIASES[first]) {
    lang = LANG_ALIASES[first];
    text = m.text.slice(m.args[0].length).trim();
  }

  if (!text) {
    return m.reply(
      `🗣️ *Text to Speech*\n\n> Usage: \`${prefix}tts <lang> <text>\`\n> Example: \`${prefix}tts en Hello world\``,
    );
  }

  await m.react("🕕");
  try {
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(
      text.slice(0, 200),
    )}&tl=${lang}&client=tw-ob`;
    const res = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 20000,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
    });
    const buffer = Buffer.from(res.data);
    if (!buffer.length) throw new Error("Empty audio response");
    await sock.sendMessage(
      m.chat,
      { audio: buffer, mimetype: "audio/mpeg", ptt: true },
      { quoted: m.raw },
    );
    await m.react("✅");
  } catch (error) {
    await m.react("☢");
    await m.reply("❌ Failed to generate speech. Try a shorter text or a different language.");
  }
}

export { pluginConfig as config, handler };
