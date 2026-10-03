/**
 * GX-ID — /sendmessage (admin, bot-admin)
 *
 * Toggles whether non-admin members may send messages (announcement mode).
 */
import { setMembersCanSendMessage } from "../../lib/group-service.js";
import { parseToggle, toggleLabel, ensureBotAdmin, BOT_NOT_ADMIN } from "../../lib/plugin-utils.js";

const pluginConfig = {
  name: "sendmessage",
  alias: ["allowmessage", "izinkanpesan"],
  category: "group",
  description: "Izinkan/larang anggota non-admin mengirim pesan",
  usage: ".sendmessage <on|off>",
  examples: [".sendmessage off", ".sendmessage on"],
  helpOnEmpty: false,
  permission: "admin",
  isBotAdmin: true,
  cooldown: 10,
  isEnabled: true,
};

async function handler(m, { sock, config }) {
  const prefix = m.prefix || config.command?.prefix || ".";
  const state = parseToggle(m.args?.[0]);
  if (state === null) {
    const current = m.groupMetadata?.announce ? "off" : "on";
    return m.reply(`💬 *Send Message*\n\n> Current: ${toggleLabel(current === "on")}\n> Usage: \`${prefix}sendmessage <on|off>\``);
  }
  if (!(await ensureBotAdmin(m, sock))) return m.reply(BOT_NOT_ADMIN);

  await setMembersCanSendMessage(sock, m.chat, state);
  await m.reply(`✅ Anggota non-admin ${state ? "sekarang bisa" : "tidak lagi bisa"} mengirim pesan.`);
}

export { pluginConfig as config, handler };
