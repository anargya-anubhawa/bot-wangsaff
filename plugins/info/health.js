/**
 * VEA — /health
 *
 * Ringkasan kondisi runtime: uptime proses & koneksi, memori, status WhatsApp,
 * ukuran database, jumlah plugin + yang gagal dimuat, serta jumlah cache. Untuk
 * diagnosis cepat tanpa membuka console.
 */
import os from "os";
import { getUptime, isConnected } from "../../core/connection.js";
import { getDatabase } from "../../lib/database.js";
import { getPluginCount, getLoadErrors } from "../../lib/plugins.js";
import { recentMessagesStats } from "../../lib/recent-messages.js";

const pluginConfig = {
  name: "health",
  alias: ["status", "doctor", "diagnose"],
  category: "info",
  description: "Ringkasan kesehatan bot (uptime, memori, koneksi, plugin, cache)",
  usage: ".health",
  examples: [".health"],
  permission: "all",
  cooldown: 5,
  isEnabled: true,
};

function fmtBytes(bytes = 0) {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(1)} MB`;
}

function fmtUptime(ms = 0) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

async function handler(m) {
  const mem = process.memoryUsage();
  const db = getDatabase();

  let users = 0;
  let events = 0;
  try {
    users = db.getUserCount?.() ?? 0;
    events = db.eventLogCount?.() ?? 0;
  } catch {
    /* ignore */
  }

  const loadErrors = getLoadErrors();
  const cache = (() => {
    try {
      return recentMessagesStats();
    } catch {
      return { chats: 0, messages: 0, media: 0 };
    }
  })();

  const lines = [
    "*Bot Health*",
    "",
    `Uptime proses: *${fmtUptime(process.uptime() * 1000)}*`,
    `Uptime koneksi: *${isConnected() ? fmtUptime(getUptime()) : "offline"}*`,
    `WhatsApp: *${isConnected() ? "connected" : "disconnected"}*`,
    "",
    `RAM (rss): *${fmtBytes(mem.rss)}*`,
    `Heap used: *${fmtBytes(mem.heapUsed)} / ${fmtBytes(mem.heapTotal)}*`,
    `System load: *${os.loadavg()[0].toFixed(2)}* (${os.cpus().length} core)`,
    `Free RAM: *${fmtBytes(os.freemem())} / ${fmtBytes(os.totalmem())}*`,
    "",
    `Plugin: *${getPluginCount()} aktif${loadErrors.length ? `, ${loadErrors.length} gagal` : ""}*`,
    `DB users: *${users}*`,
    `Event log: *${events}*`,
    `Cache pesan: *${cache.chats} chat, ${cache.messages} pesan, ${cache.media} media*`,
  ];

  if (loadErrors.length) {
    lines.push("");
    lines.push("*Gagal dimuat:*");
    for (const e of loadErrors.slice(0, 10)) {
      lines.push(`- ${e.file}: ${e.error}`);
    }
  }

  await m.reply(lines.join("\n"), { keep: true });
}

export { pluginConfig as config, handler };
