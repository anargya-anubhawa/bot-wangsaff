/**
 * VEA — /cachestat
 *
 * Menampilkan pemakaian cache pesan (recent-messages) beserta batasnya, supaya
 * pemakaian memori untuk revoke/save bisa dipantau. Cache menyimpan pesan
 * terakhir per chat agar bisa dipulihkan (`.save`) atau di-log saat dihapus.
 */
import { recentMessagesStats } from "../../lib/recent-messages.js";

const pluginConfig = {
  name: "cachestat",
  alias: ["cache", "memstat", "cachestatus"],
  category: "info",
  description: "Statistik cache pesan (recent-messages) dan batasnya",
  usage: ".cachestat",
  examples: [".cachestat"],
  permission: "owner",
  cooldown: 3,
  isEnabled: true,
};

function fmtBytes(bytes = 0) {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(1)} MB`;
}

async function handler(m) {
  const s = recentMessagesStats();
  const l = s.limits;
  const lines = [
    "*Cache Pesan*",
    "",
    `Chat tersimpan: *${s.chats}*`,
    `Total pesan: *${s.messages} / ${l.maxTotalMessages}*`,
    `Media tersimpan: *${s.media}*`,
    `Ukuran media: *${fmtBytes(s.mediaBytes)} / ${fmtBytes(l.maxTotalMediaBytes)}*`,
    "",
    "*Batas:*",
    `Per chat: *${l.maxPerChat} pesan, ${l.maxMediaPerChat} media*`,
    `Per file media: *${fmtBytes(l.maxMediaBytes)}*`,
    `Global: *${l.maxTotalMessages} pesan, ${fmtBytes(l.maxTotalMediaBytes)} media*`,
    "",
    "Cache tanpa kadaluwarsa waktu, dibatasi jumlah dan ukuran.",
  ];
  await m.reply(lines.join("\n"), { keep: true });
}

export { pluginConfig as config, handler };
