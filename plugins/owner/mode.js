/**
 * GX-ID — /mode (owner only)
 *
 * Toggle the bot between public, self, private, group and reggroup mode.
 */
const MODES = ["public", "self", "private", "group", "reggroup"];

const pluginConfig = {
  name: "mode",
  alias: ["botmode", "setmode"],
  category: "owner",
  description: "Set the bot mode (public/self/private/group/reggroup)",
  usage: ".mode <public|self|private|group|reggroup>",
  example: ".mode group",
  isOwner: true,
  cooldown: 3,
  isEnabled: true,
};

async function handler(m, { db, config }) {
  const prefix = m.prefix || config.command?.prefix || ".";
  const arg = (m.args[0] || "").toLowerCase();
  if (!MODES.includes(arg)) {
    const current = (db.setting("botMode") || config.mode || "public").toUpperCase();
    return m.reply(
      `⚙️ *Mode*\n\n> Current: *${current}*\n> Usage: \`${prefix}mode <${MODES.join("|")}>\``,
    );
  }
  db.setting("botMode", arg);
  await m.reply(`✅ *Bot mode set to* *${arg.toUpperCase()}*`);
}

export { pluginConfig as config, handler };
