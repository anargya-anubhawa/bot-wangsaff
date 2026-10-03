/**
 * GX-ID — /animstickeroptions (owner)
 *
 * Configures the animated-sticker conversion parameters used by
 * `animsticker` (global setting).
 *
 *   .animstickeroptions duration=6,fps=15,emojis=😀 😂
 */
import { getAnimStickerOptions, setAnimStickerOptions } from "../../lib/settings.js";

const pluginConfig = {
  name: "animstickeroptions",
  alias: ["animstikeroptions", "animstickeropt"],
  category: "media",
  description: "Atur parameter konversi stiker animasi (global)",
  usage: ".animstickeroptions <duration=N,fps=N,emojis=...>",
  examples: [".animstickeroptions duration=6,fps=15", ".animstickeroptions reset"],
  helpOnEmpty: false,
  permission: "owner",
  cooldown: 3,
  isEnabled: true,
};

async function handler(m, { config }) {
  const prefix = m.prefix || config.command?.prefix || ".";
  const arg = (m.text || "").trim();

  if (!arg || arg === "status") {
    const current = getAnimStickerOptions();
    return m.reply(
      `🎞️ *Anim Sticker Options*\n\n> Saat ini: \`${current || "(default: duration=6,fps=15)"}\`\n> Usage: \`${prefix}animstickeroptions duration=6,fps=15\`\n> Reset: \`${prefix}animstickeroptions reset\``,
    );
  }

  if (arg === "reset") {
    setAnimStickerOptions("");
    return m.reply("✅ Opsi stiker animasi direset ke default.");
  }

  const valid = /^[a-z]+=[^\s,]+(,[a-z]+=[^\s,]+)*$/i.test(arg);
  if (!valid) {
    return m.reply(`❌ Format tidak valid.\n\n> Contoh: \`${prefix}animstickeroptions duration=6,fps=15\``);
  }

  setAnimStickerOptions(arg);
  await m.reply(`✅ Opsi stiker animasi diatur: \`${arg}\`.`);
}

export { pluginConfig as config, handler };
