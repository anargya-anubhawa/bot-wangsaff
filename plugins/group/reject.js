/**
 * GX-ID — /reject (admin, bot-admin)
 *
 * Rejects pending join requests. `.reject all` rejects everyone waiting.
 */
import { listPendingJoinRequests, rejectJoinRequests } from "../../lib/group-service.js";
import { normalizeToJid } from "../../lib/group-utils.js";
import { ensureBotAdmin, BOT_NOT_ADMIN } from "../../lib/plugin-utils.js";

const pluginConfig = {
  name: "reject",
  alias: ["rejectjoin", "tolak", "tolakgabung"],
  category: "group",
  description: "Tolak permintaan gabung yang menunggu",
  usage: ".reject <nomor|all>",
  examples: [".reject all", ".reject 6281234567890"],
  permission: "admin",
  isBotAdmin: true,
  cooldown: 5,
  isEnabled: true,
};

async function handler(m, { sock, config }) {
  const prefix = m.prefix || config.command?.prefix || ".";
  if (!m.args?.length) return m.reply(`❌ Berikan nomor atau \`all\`.\n\n> Contoh: \`${prefix}reject all\``);
  if (!(await ensureBotAdmin(m, sock))) return m.reply(BOT_NOT_ADMIN);

  if ((m.args[0] || "").toLowerCase() === "all") {
    const list = await listPendingJoinRequests(sock, m.chat);
    if (!list.length) return m.reply("ℹ️ Tidak ada permintaan gabung yang menunggu.");
    await rejectJoinRequests(sock, m.chat, list.map((p) => p.jid));
    return m.reply(`✅ ${list.length} permintaan gabung ditolak.`);
  }

  const jids = m.args.map(normalizeToJid).filter(Boolean);
  if (!jids.length) return m.reply("❌ Nomor tidak valid.");
  await rejectJoinRequests(sock, m.chat, jids);
  await m.reply(`✅ Ditolak: ${jids.map((j) => j.split("@")[0]).join(", ")}`);
}

export { pluginConfig as config, handler };
