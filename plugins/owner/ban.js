/**
 * GX-ID — /ban & /unban (owner only)
 *
 * Ban/unban a user from using the bot.
 */
const pluginConfig = {
  name: "ban",
  alias: ["banuser"],
  category: "owner",
  description: "Ban a user from using the bot",
  usage: ".ban @user (or reply)",
  example: ".ban @user",
  isOwner: true,
  cooldown: 3,
  isEnabled: true,
};

async function handler(m, { db, config }) {
  const prefix = m.prefix || config.command?.prefix || ".";
  let target = m.quoted?.sender || m.mentionedJid?.[0];
  if (!target && m.args[0]) {
    const num = m.args[0].replace(/[^0-9]/g, "");
    if (num.length >= 8) target = `${num}@s.whatsapp.net`;
  }
  if (!target) {
    return m.reply(`🚫 *Ban*\n\n> Reply to a user, mention them, or provide a number.\n> Usage: \`${prefix}ban @user\``);
  }

  const number = target.split("@")[0];
  if (config.isOwner?.(number)) return m.reply("❌ Cannot ban an owner.");

  const list = db.setting("bannedUsers") || [];
  if (list.some((b) => String(b).split("@")[0] === number)) {
    return m.reply(`⚠️ @${number} is already banned.`, { mentions: [target] });
  }

  list.push(target);
  db.setting("bannedUsers", list);
  db.setUser(target, { isBanned: true });
  await m.reply(`🚫 *@${number} has been banned.*`, { mentions: [target] });
}

export { pluginConfig as config, handler };
