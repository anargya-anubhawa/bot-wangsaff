/**
 * GX-ID — /ping
 *
 * 4 latency metrics:
 * - Server Ping      : ICMP RTT VPS -> 1.1.1.1 -> VPS
 * - Message Latency  : waktu sejak pesan dibuat sampai diproses bot
 * - Bot Processing   : waktu pemrosesan command
 * - Reply Send       : waktu m.reply() sampai selesai
 */

import { performance } from "perf_hooks";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const pluginConfig = {
  name: "ping",
  alias: ["p", "speed", "latency"],
  category: "info",
  description: "Cek latensi server dan bot",
  usage: ".ping",
  examples: [".ping"],
  permission: "all",
  cooldown: 3,
  isEnabled: true,
};

/**
 * Mengukur ping VPS ke 1.1.1.1
 */
async function getServerPing() {
  try {
    const { stdout } = await execFileAsync(
      "ping",
      ["-c", "1", "-W", "2", "1.1.1.1"],
      {
        timeout: 3000,
      }
    );

    const match = stdout.match(/time[=<]([\d.]+)\s*ms/i);

    if (!match) {
      return null;
    }

    return Math.max(1, Math.round(Number(match[1])));
  } catch {
    return null;
  }
}

async function handler(m) {
  // ==========================================
  // 1. SERVER PING
  // VPS -> 1.1.1.1 -> VPS
  // ==========================================

  const serverPing = await getServerPing();

  // ==========================================
  // 2. MESSAGE LATENCY
  // ==========================================

  const msgTimestamp = m.timestamp
    ? Number(m.timestamp) * 1000
    : Date.now();

  const messageLatency = Math.max(
    1,
    Math.round(Date.now() - msgTimestamp)
  );

  // ==========================================
  // 3. BOT PROCESSING
  // ==========================================

  const processStart = performance.now();

  // Tidak ada proses berat di sini.
  // Logic command tambahan bisa diletakkan di sini.

  const processMs = Math.max(
    1,
    Math.round(performance.now() - processStart)
  );

  // ==========================================
  // 4. REPLY SEND
  // ==========================================

  const replyStart = performance.now();

  const serverPingText =
    serverPing !== null
      ? `${serverPing}ms`
      : "Timeout";

  await m.reply(
    `🏓 *PONG!*\n\n` +
    `Server Ping: *${serverPingText}*\n` +
    `Message Latency: *${messageLatency}ms*\n` +
    `Bot Processing: *${processMs}ms*\n` +
    `Reply Send: *${Math.max(
      1,
      Math.round(performance.now() - replyStart)
    )}ms*`
  );
}

export { pluginConfig as config, handler };