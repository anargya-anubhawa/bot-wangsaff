/**
 * GX-ID — /approve (admin, bot-admin)
 *
 * Approves pending join requests. `.approve all` approves everyone waiting.
 */
import { listPendingJoinRequests, approveJoinRequests } from "../../lib/group-service.js";
import { normalizeToJid } from "../../lib/group-utils.js";
import { ensureBotAdmin, BOT_NOT_ADMIN } from "../../lib/plugin-utils.js";

const pluginConfig = {
  name: "approve",
  alias: ["approvejoin", "terima", "terimagabung"],
  category: "group",
  description: "Setujui permintaan gabung yang menunggu",
  usage: ".approve <nomor|all>",
  examples: [".approve all", ".approve 6281234567890"],
  permission: "admin",
  isBotAdmin: true,
  cooldown: 5,
  isEnabled: true,
};

async function handler(m, { sock, config }) {
  const prefix = m.prefix || config.command?.prefix || ".";
  if (!m.args?.length) return m.reply(`❌ Berikan nomor atau \`all\`.\n\n> Contoh: \`${prefix}approve all\``);
  if (!(await ensureBotAdmin(m, sock))) return m.reply(BOT_NOT_ADMIN);

  if ((m.args[0] || "").toLowerCase() === "all") {
    const list = await listPendingJoinRequests(sock, m.chat);
    if (!list.length) return m.reply("ℹ️ Tidak ada permintaan gabung yang menunggu.");
    await approveJoinRequests(sock, m.chat, list.map((p) => p.jid));
    return m.reply(`✅ ${list.length} permintaan gabung disetujui.`);
  }

  const jids = m.args.map(normalizeToJid).filter(Boolean);
  if (!jids.length) return m.reply("❌ Nomor tidak valid.");
  await approveJoinRequests(sock, m.chat, jids);
  await m.reply(`✅ Disetujui: ${jids.map((j) => j.split("@")[0]).join(", ")}`);
}

export { pluginConfig as config, handler };
