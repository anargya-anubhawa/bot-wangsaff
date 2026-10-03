/**
 * GX-ID — /joinapproval (admin, bot-admin)
 *
 * Requires admin approval for new members.
 */
import { setJoinApprovalRequired } from "../../lib/group-service.js";
import { parseToggle, ensureBotAdmin, BOT_NOT_ADMIN } from "../../lib/plugin-utils.js";

const pluginConfig = {
  name: "joinapproval",
  alias: ["approvaljoin", "persetujuanganggota"],
  category: "group",
  description: "Wajibkan persetujuan admin untuk anggota baru",
  usage: ".joinapproval <on|off>",
  examples: [".joinapproval on"],
  permission: "admin",
  isBotAdmin: true,
  cooldown: 10,
  isEnabled: true,
};

async function handler(m, { sock, config }) {
  const prefix = m.prefix || config.command?.prefix || "";
  const state = parseToggle(m.args?.[0]);
  if (state === null) {
    return m.reply(`🚪 *Join Approval*\n\n> Usage: \`${prefix}joinapproval <on|off>\``);
  }
  if (!(await ensureBotAdmin(m, sock))) return m.reply(BOT_NOT_ADMIN);

  await setJoinApprovalRequired(sock, m.chat, state);
  await m.reply(`✅ Persetujuan gabung ${state ? "diaktifkan" : "dinonaktifkan"}.`);
}

export { pluginConfig as config, handler };
