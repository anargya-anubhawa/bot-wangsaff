/**
 * GX-ID — /editsettings (admin, bot-admin)
 *
 * Toggles whether non-admin members may edit group settings.
 */
import { setMembersCanEditSettings } from "../../lib/group-service.js";
import { parseToggle, toggleLabel, ensureBotAdmin, BOT_NOT_ADMIN } from "../../lib/plugin-utils.js";

const pluginConfig = {
  name: "editsettings",
  alias: ["allowedit", "izinkansetting"],
  category: "group",
  description: "Izinkan/larang anggota non-admin mengubah pengaturan grup",
  usage: ".editsettings <on|off>",
  examples: [".editsettings off"],
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
    const locked = m.groupMetadata?.restrict;
    const current = locked ? "off" : "on";
    return m.reply(`⚙️ *Edit Settings*\n\n> Current: ${toggleLabel(current === "on")}\n> Usage: \`${prefix}editsettings <on|off>\``);
  }
  if (!(await ensureBotAdmin(m, sock))) return m.reply(BOT_NOT_ADMIN);

  await setMembersCanEditSettings(sock, m.chat, state);
  await m.reply(`✅ Anggota non-admin ${state ? "sekarang bisa" : "tidak lagi bisa"} mengubah pengaturan grup.`);
}

export { pluginConfig as config, handler };
