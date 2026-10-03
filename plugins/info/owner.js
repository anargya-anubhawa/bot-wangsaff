/**
 * GX-ID — /owner
 */
const pluginConfig = {
  name: "owner",
  alias: ["creator", "pemilik"],
  category: "info",
  description: "Show the bot owner's contact",
  usage: ".owner",
  example: ".owner",
  isOwner: false,
  isGroup: false,
  cooldown: 5,
  isEnabled: true,
};

async function handler(m, { sock, config }) {
  const owners = Array.isArray(config.owner?.number) ? config.owner.number : [];
  if (!owners.length) {
    return m.reply(`👑 *Owner:* ${config.owner?.name || "Owner"}`);
  }

  const contacts = owners.map((num) => ({ name: config.owner?.name || "Owner", number: num }));
  const text = `👑 *Bot Owner*\n\n> Name: *${config.owner?.name || "Owner"}*\n> Number: ${owners.map((n) => `+${n}`).join(", ")}`;

  try {
    await sock.sendMessage(m.chat, { text }, { quoted: m.raw });
    await sock.sendContact(m.chat, contacts, { quoted: m.raw });
  } catch {
    await m.reply(text);
  }
}

export { pluginConfig as config, handler };
