/**
 * GX-ID — /leave (owner)
 *
 * Makes the bot leave the current group. Restricted to owner/whitelist so an
 * ordinary user can never force the bot out of a group.
 */
const pluginConfig = {
  name: "leave",
  alias: ["keluar", "leavegroup", "botleave"],
  category: "group",
  description: "Buat bot keluar dari grup ini (khusus owner)",
  usage: ".leave",
  examples: [".leave"],
  permission: "owner",
  isGroup: true,
  cooldown: 10,
  isEnabled: true,
};

async function handler(m, { sock }) {
  const group = m.groupMetadata?.subject || m.chat.split("@")[0];
  await m.reply(`👋 Bot keluar dari *${group}*.`);
  try {
    await sock.groupLeave(m.chat);
  } catch (error) {
    await m.reply("❌ Gagal keluar dari grup. Pastikan bot masih menjadi anggota.");
    throw error;
  }
}

export { pluginConfig as config, handler };
