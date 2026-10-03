/**
 * GX-ID — /setname
 *
 * Change the group subject.
 */
const pluginConfig = {
  name: "setname",
  alias: ["setnamegc", "setsubject", "gcsname"],
  category: "group",
  description: "Change the group name",
  usage: ".setname <new name>",
  example: ".setname My Group",
  isGroup: true,
  isAdmin: true,
  isBotAdmin: true,
  cooldown: 10,
  isEnabled: true,
};

async function handler(m, { sock, config }) {
  const prefix = m.prefix || config.command?.prefix || ".";
  const name = m.text?.trim();
  if (!name) return m.reply(`Provide a new name.\n\n> Usage: \`${prefix}setname <new name>\``);

  await m.react("🕕");
  try {
    await sock.groupUpdateSubject(m.chat, name);
    await m.reply(`✅ *Group name changed* to:\n> ${name}`);
    await m.react("✅");
  } catch (error) {
    await m.react("☢");
    throw error;
  }
}

export { pluginConfig as config, handler };
