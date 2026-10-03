/**
 * GX-ID — /memberaddmode (admin, bot-admin)
 *
 * Controls who may add new members directly: `admin` (admins only) or `all`.
 */
import { setMemberAddMode } from "../../lib/group-service.js";
import { ensureBotAdmin, BOT_NOT_ADMIN } from "../../lib/plugin-utils.js";

const pluginConfig = {
  name: "memberaddmode",
  alias: ["addmode", "modeaddmember"],
  category: "group",
  description: "Atur siapa yang boleh menambahkan anggota baru langsung",
  usage: ".memberaddmode <admin|all>",
  examples: [".memberaddmode admin", ".memberaddmode all"],
  permission: "admin",
  isBotAdmin: true,
  cooldown: 10,
  isEnabled: true,
};

async function handler(m, { sock, config }) {
  const prefix = m.prefix || config.command?.prefix || ".";
  const mode = (m.args?.[0] || "").toLowerCase();
  if (mode !== "admin" && mode !== "all") {
    return m.reply(`➕ *Member Add Mode*\n\n> Usage: \`${prefix}memberaddmode <admin|all>\`\n> \`admin\` — hanya admin\n> \`all\` — semua anggota`);
  }
  if (!(await ensureBotAdmin(m, sock))) return m.reply(BOT_NOT_ADMIN);

  await setMemberAddMode(sock, m.chat, mode === "admin" ? "admin_add" : "all_member_add");
  await m.reply(`✅ Mode penambahan anggota diatur ke *${mode}*.`);
}

export { pluginConfig as config, handler };
