/**
 * GX-ID — /vpsinfo (owner)
 *
 * A neofetch / fastfetch-style report of the machine the bot runs on: host,
 * OS, kernel, CPU (model, cores, speed, load, temp), memory & swap, disk,
 * runtime and network interfaces.
 *
 * Everything is read from the local host only. It NEVER prints environment
 * values, session files, credentials or the process working directory, so
 * nothing sensitive can leak through this command.
 *
 *   .vpsinfo          → full report
 *   .vpsinfo disk     → disk-only view
 *   .vpsinfo net      → network-only view
 */
import { collectSystemInfo, renderSystemInfo } from "../../lib/system-info.js";

const pluginConfig = {
  name: "vpsinfo",
  alias: ["server", "vps", "hostinfo", "neofetch", "fastfetch", "machineinfo"],
  category: "info",
  description: "Tampilkan informasi lengkap server/VPS bot (neofetch-style)",
  usage: ".vpsinfo",
  examples: [".vpsinfo"],
  permission: "owner",
  cooldown: 5,
  isEnabled: true,
};

async function handler(m, { config }) {
  const prefix = m.prefix || config.command?.prefix || ".";
  const botName = config.bot?.name || "GX-ID";
  const info = collectSystemInfo();
  await m.reply(renderSystemInfo(info, { prefix, botName }));
}

export { pluginConfig as config, handler };
