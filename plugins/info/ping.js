/**
 * GX-ID — /ping
 *
 * Minimal latency check: replies "Pong" with the round-trip latency in ms.
 * Everything else (uptime, plugins, system stats) lives in `.botinfo`.
 */
import { performance } from "perf_hooks";

const pluginConfig = {
  name: "ping",
  alias: ["p", "speed", "latency"],
  category: "info",
  description: "Cek latensi bot (Pong + ms)",
  usage: ".ping",
  examples: [".ping"],
  permission: "all",
  cooldown: 3,
  isEnabled: true,
};

async function handler(m) {
  const start = performance.now();

  const msgTimestamp = m.timestamp ? Number(m.timestamp) * 1000 : Date.now();
  const latency = Math.max(1, Math.round(Date.now() - msgTimestamp));
  const processMs = Math.max(1, Math.round(performance.now() - start));

  await m.reply(`🏓 *PONG!*\n\n> Latency: *${latency}ms*\n> Process: *${processMs}ms*`);
}

export { pluginConfig as config, handler };
