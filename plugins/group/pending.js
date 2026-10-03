/**
 * GX-ID — /pending (admin, bot-admin)
 *
 * Lists members waiting for join approval.
 */
import { listPendingJoinRequests } from "../../lib/group-service.js";
import { numberFromJid } from "../../lib/group-utils.js";

const pluginConfig = {
  name: "pending",
  alias: ["joinrequests", "pendingjoin", "menunggugabung"],
  category: "group",
  description: "Tampilkan anggota yang menunggu persetujuan gabung",
  usage: ".pending",
  examples: [".pending"],
  permission: "admin",
  isBotAdmin: true,
  cooldown: 5,
  isEnabled: true,
};

async function handler(m, { sock }) {
  const list = await listPendingJoinRequests(sock, m.chat);
  if (!list.length) return m.reply("ℹ️ Tidak ada permintaan gabung yang menunggu.");

  const lines = list.map((p, i) => {
    const pn = p.phone_number || p.phoneNumber || p.pn;
    const display = pn ? numberFromJid(pn) : numberFromJid(p.jid);
    return `› ${i + 1}. ${display}`;
  });
  await m.reply(
    `⏳ *Permintaan gabung (${list.length})*\n\n${lines.join("\n")}\n\n> Setujui: \`.approve <nomor|all>\`\n> Tolak: \`.reject <nomor|all>\``,
  );
}

export { pluginConfig as config, handler };
