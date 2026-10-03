/**
 * GX-ID — /linkgc
 */
const pluginConfig = {
  name: "linkgc",
  alias: ["linkgrup", "getlink", "gclink", "linkgroup"],
  category: "group",
  description: "Get the group invite link",
  usage: ".linkgc",
  example: ".linkgc",
  isGroup: true,
  isAdmin: true,
  isBotAdmin: true,
  cooldown: 10,
  isEnabled: true,
};

async function handler(m, { sock }) {
  await m.react("🕕");
  try {
    const code = await sock.groupInviteCode(m.chat);
    await m.reply(`🔗 *Group invite link*\n\nhttps://chat.whatsapp.com/${code}`);
    await m.react("✅");
  } catch (error) {
    await m.react("☢");
    throw error;
  }
}

export { pluginConfig as config, handler };
