/**
 * GX-ID — /revoke
 *
 * Revokes (resets) the group invite link.
 */
const pluginConfig = {
  name: "revoke",
  alias: ["resetlinkgc", "resetlink", "revokelink"],
  category: "group",
  description: "Reset the group invite link",
  usage: ".revoke",
  example: ".revoke",
  isGroup: true,
  isAdmin: true,
  isBotAdmin: true,
  cooldown: 10,
  isEnabled: true,
};

async function handler(m, { sock }) {
  await m.react("🕕");
  try {
    await sock.groupRevokeInvite(m.chat);
    const code = await sock.groupInviteCode(m.chat);
    await m.reply(`♻️ *Invite link reset.*\n\n🔗 https://chat.whatsapp.com/${code}`);
    await m.react("✅");
  } catch (error) {
    await m.react("☢");
    throw error;
  }
}

export { pluginConfig as config, handler };
