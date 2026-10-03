/**
 * GX-ID — /setdesc
 *
 * Change the group description.
 */
const pluginConfig = {
  name: "setdesc",
  alias: ["setdeskgc", "setdescription", "gcdesc"],
  category: "group",
  description: "Change the group description",
  usage: ".setdesc <new description>",
  example: ".setdesc Welcome to our group!",
  isGroup: true,
  isAdmin: true,
  isBotAdmin: true,
  cooldown: 10,
  isEnabled: true,
};

async function handler(m, { sock, config }) {
  const prefix = m.prefix || config.command?.prefix || ".";
  const desc = m.text?.trim();
  if (!desc) return m.reply(`Provide a description.\n\n> Usage: \`${prefix}setdesc <description>\``);

  await m.react("🕕");
  try {
    await sock.groupUpdateDescription(m.chat, desc);
    await m.reply("✅ *Group description updated.*");
    await m.react("✅");
  } catch (error) {
    await m.react("☢");
    throw error;
  }
}

export { pluginConfig as config, handler };
