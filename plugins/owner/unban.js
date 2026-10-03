/**
 * GX-ID — /unban (owner only)
 */
const pluginConfig = {
  name: "unban",
  alias: ["unbanuser"],
  category: "owner",
  description: "Unban a user",
  usage: ".unban @user (or reply)",
  example: ".unban @user",
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
    return m.reply(`✅ *Unban*\n\n> Reply to a user, mention them, or provide a number.\n> Usage: \`${prefix}unban @user\``);
  }

  const number = target.split("@")[0];
  const list = (db.setting("bannedUsers") || []).filter((b) => String(b).split("@")[0] !== number);
  db.setting("bannedUsers", list);
  db.setUser(target, { isBanned: false });
  await m.reply(`✅ *@${number} has been unbanned.*`, { mentions: [target] });
}

export { pluginConfig as config, handler };
