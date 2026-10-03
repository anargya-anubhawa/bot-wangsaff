/**
 * GX-ID — /presence (owner)
 *
 * Unified control for the outgoing "typing…" presence simulation, merging the
 * former `presencesim`, `presencedelay` and `presencestatus` plugins.
 *
 *   .presence                     → show the current status
 *   .presence status              → same as above
 *   .presence on | off            → toggle the simulation
 *   .presence delay <min> <max>   → base typing-delay range (ms)
 *
 * Aliases (back-compat): presencesim/simulasi, presencedelay/setpresencedelay,
 * presencestatus/presenceinfo.
 */
import {
  isPresenceSimEnabled,
  setPresenceSimEnabled,
  getPresenceDelayRange,
  setPresenceDelayRange,
} from "../../lib/settings.js";

const MAX_ALLOWED_MS = 10_000;

const pluginConfig = {
  name: "presence",
  alias: [
    "presencesim",
    "simulasi",
    "presencedelay",
    "setpresencedelay",
    "presencestatus",
    "presenceinfo",
  ],
  category: "bot-config",
  description: "Kelola simulasi presence (mengetik) sebelum bot mengirim pesan",
  usage: ".presence [status|on|off|delay <min> <max>]",
  examples: [".presence on", ".presence status", ".presence delay 600 1800"],
  parameters: [
    { name: "status", description: "Tampilkan status simulasi presence" },
    { name: "on", description: "Aktifkan simulasi presence" },
    { name: "off", description: "Nonaktifkan simulasi presence" },
    { name: "delay", description: "Jeda dasar: delay <minMs> <maxMs>" },
  ],
  helpOnEmpty: true,
  permission: "owner",
  cooldown: 3,
  isEnabled: true,
};

function parseToggle(arg) {
  const v = String(arg || "").toLowerCase();
  if (["on", "yes", "enable", "aktif", "1", "true"].includes(v)) return true;
  if (["off", "no", "disable", "mati", "0", "false"].includes(v)) return false;
  return null;
}

function statusText() {
  const [min, max] = getPresenceDelayRange();
  return `⌨️ *Presence Status*\n\n> Simulasi: ${isPresenceSimEnabled() ? "✅ ON" : "❌ OFF"}\n> Jeda dasar: *${min}-${max}ms*`;
}

async function handleStatus(m) {
  await m.reply(statusText());
}

async function handleToggle(m, prefix, value) {
  const state = parseToggle(value);
  if (state === null) {
    return m.reply(`⌨️ *Presence Sim*: ${isPresenceSimEnabled() ? "✅ ON" : "❌ OFF"}\n\n> Usage: \`${prefix}presence <on|off>\``);
  }
  setPresenceSimEnabled(state);
  await m.reply(`✅ Simulasi presence ${state ? "diaktifkan" : "dinonaktifkan"}.`);
}

async function handleDelay(m, prefix, args) {
  const min = Number(args[0]);
  const max = Number(args[1]);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min || max > MAX_ALLOWED_MS) {
    return m.reply(
      `⌨️ *Presence Delay*\n\n> Usage: \`${prefix}presence delay <minMs> <maxMs>\`\n> Syarat: 0 ≤ min ≤ max ≤ ${MAX_ALLOWED_MS}`,
    );
  }
  setPresenceDelayRange(min, max);
  await m.reply(`✅ Jeda presence diatur ke *${min}-${max}ms*.`);
}

async function handler(m, ctx) {
  const prefix = m.prefix || ctx.config?.command?.prefix || ".";
  const invoked = String(m.command || "presence").toLowerCase();
  const args = m.args || [];

  if (invoked === "presencedelay" || invoked === "setpresencedelay") {
    return handleDelay(m, prefix, args);
  }
  if (invoked === "presencestatus" || invoked === "presenceinfo") {
    return handleStatus(m);
  }
  if (invoked === "presencesim" || invoked === "simulasi") {
    return handleToggle(m, prefix, args[0]);
  }

  /* primary: `.presence <sub>` */
  const sub = (args[0] || "").toLowerCase();
  if (sub === "delay") return handleDelay(m, prefix, args.slice(1));
  if (sub === "status" || sub === "info") return handleStatus(m);
  if (!sub) return handleStatus(m);
  return handleToggle(m, prefix, args[0]);
}

export { pluginConfig as config, handler };
