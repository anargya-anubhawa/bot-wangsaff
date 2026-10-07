/**
 * GX-ID — /silent (owner only)
 *
 * Toggle silent mode: while ON, the bot suppresses every gate/refusal notice
 * (unknown command, command disabled, cooldown, owner-only / group-only /
 * admin-only denials, ban, unregistered group, anti-call, …).
 *
 *   .silent            → show the current state
 *   .silent on         → suppress the notices
 *   .silent off        → send the notices again
 *
 * The choice persists in the database (`silentMode`) and overrides the
 * `config.messages.silent` default. Functional command output and the
 * bare-command usage/help cards are never silenced.
 */
import { silentEnabled, setSilentMode } from "../../lib/messages.js";

const pluginConfig = {
  name: "silent",
  alias: ["silentmode", "hening", "bisukan"],
  category: "owner",
  description: "Nyalakan/matikan silent mode (sembunyikan pesan penolakan/error)",
  usage: ".silent <on|off>",
  examples: [".silent on", ".silent off", ".silent"],
  helpOnEmpty: false,
  isOwner: true,
  cooldown: 3,
  isEnabled: true,
};

const ON_WORDS = ["on", "enable", "enabled", "true", "ya", "aktif", "1"];
const OFF_WORDS = ["off", "disable", "disabled", "false", "tidak", "nonaktif", "0"];

async function handler(m, { db, config }) {
  const prefix = m.prefix || config.command?.prefix || ".";
  const arg = (m.args[0] || "").toLowerCase();

  if (arg && !ON_WORDS.includes(arg) && !OFF_WORDS.includes(arg)) {
    return m.reply(
      `🔇 *Silent Mode*\n\n` +
        `> Status: *${silentEnabled() ? "ON" : "OFF"}*\n` +
        `> Usage: \`${prefix}silent <on|off>\`\n\n` +
        `> Saat ON, bot tidak mengirim pesan penolakan/error\n` +
        `> (command tidak dikenal, command disabled, cooldown, dst).`,
    );
  }

  if (!arg) {
    const on = silentEnabled();
    return m.reply(
      `🔇 *Silent Mode*\n\n` +
        `> Status: *${on ? "ON" : "OFF"}*\n` +
        `> Ubah: \`${prefix}silent ${on ? "off" : "on"}\``,
    );
  }

  const enabled = ON_WORDS.includes(arg);
  setSilentMode(enabled);
  await m.reply(
    enabled
      ? "🔇 *Silent mode ON.* Pesan penolakan/error tidak akan dikirim."
      : "🔊 *Silent mode OFF.* Pesan penolakan/error aktif kembali.",
  );
}

export { pluginConfig as config, handler };
