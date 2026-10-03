/**
 * GX-ID — /mode (owner only)
 *
 * Toggle the bot between public and self mode.
 */
const pluginConfig = {
  name: "mode",
  alias: ["botmode", "setmode"],
  category: "owner",
  description: "Set the bot mode (public/self)",
  usage: ".mode <public|self>",
  example: ".mode self",
  helpOnEmpty: false,
  isOwner: true,
  cooldown: 3,
  isEnabled: true,
};

async function handler(m, { db, config }) {
  const prefix = m.prefix || config.command?.prefix || ".";
  const arg = (m.args[0] || "").toLowerCase();
  if (!["public", "self"].includes(arg)) {
    const current = (db.setting("botMode") || config.mode || "public").toUpperCase();
    return m.reply(`⚙️ *Mode*\n\n> Current: *${current}*\n> Usage: \`${prefix}mode <public|self>\``);
  }
  db.setting("botMode", arg);
  await m.reply(`✅ *Bot mode set to* *${arg.toUpperCase()}*`);
}

export { pluginConfig as config, handler };
