/**
 * GX-ID — /open
 */
const pluginConfig = {
  name: "open",
  alias: ["buka", "opengroup", "bukagroup"],
  category: "group",
  description: "Open the group so all members can chat",
  usage: ".open",
  example: ".open",
  isGroup: true,
  isAdmin: true,
  isBotAdmin: true,
  cooldown: 10,
  isEnabled: true,
};

async function handler(m, { sock }) {
  if (!m.groupMetadata?.announce) {
    return m.reply("⚠️ The group is already *open* — everyone can send messages.");
  }
  try {
    await sock.groupSettingUpdate(m.chat, "not_announcement");
    await m.reply(`✅ @${m.sender.split("@")[0]} opened the group.\n_Everyone can now send messages._`, {
      mentions: [m.sender],
    });
  } catch (error) {
    throw error;
  }
}

export { pluginConfig as config, handler };
