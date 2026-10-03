/**
 * GX-ID — /close
 */
const pluginConfig = {
  name: "close",
  alias: ["tutup", "closegroup", "tutupgroup"],
  category: "group",
  description: "Close the group so only admins can chat",
  usage: ".close",
  example: ".close",
  isGroup: true,
  isAdmin: true,
  isBotAdmin: true,
  cooldown: 10,
  isEnabled: true,
};

async function handler(m, { sock }) {
  if (m.groupMetadata?.announce) {
    return m.reply("⚠️ The group is already *closed* — only admins can send messages.");
  }
  try {
    await sock.groupSettingUpdate(m.chat, "announcement");
    await m.reply(`✅ @${m.sender.split("@")[0]} closed the group.\n_Only admins can now send messages._`, {
      mentions: [m.sender],
    });
  } catch (error) {
    throw error;
  }
}

export { pluginConfig as config, handler };
