/**
 * GX-ID — /disappear (admin, bot-admin)
 *
 * Sets the disappearing-message timer (off / 24h / 7d / 90d / custom seconds).
 */
import { setDisappearingTimer } from "../../lib/group-service.js";
import { ensureBotAdmin, BOT_NOT_ADMIN } from "../../lib/plugin-utils.js";

const pluginConfig = {
  name: "disappear",
  alias: ["ephemeral", "pesansementara"],
  category: "group",
  description: "Atur timer pesan sementara (disappearing messages)",
  usage: ".disappear <off|24h|7d|90d|<detik>>",
  examples: [".disappear 24h", ".disappear off"],
  permission: "admin",
  isBotAdmin: true,
  cooldown: 10,
  isEnabled: true,
};

const TIMER_PRESETS = { off: 0, "24h": 86400, "7d": 604800, "90d": 7776000 };

async function handler(m, { sock, config }) {
  const prefix = m.prefix || config.command?.prefix || ".";
  const arg = (m.args?.[0] || "").toLowerCase();
  if (!arg) {
    return m.reply(`⏱️ *Disappearing Messages*\n\n> Usage: \`${prefix}disappear <off|24h|7d|90d|<detik>>\``);
  }

  let seconds = TIMER_PRESETS[arg];
  if (seconds === undefined) {
    const n = Number(arg);
    if (!Number.isFinite(n) || n < 0) return m.reply("❌ Nilai tidak valid.");
    seconds = Math.floor(n);
  }
  if (!(await ensureBotAdmin(m, sock))) return m.reply(BOT_NOT_ADMIN);

  await setDisappearingTimer(sock, m.chat, seconds);
  await m.reply(`✅ Pesan sementara diatur ke ${seconds === 0 ? "*nonaktif*" : `*${seconds} detik*`}.`);
}

export { pluginConfig as config, handler };
