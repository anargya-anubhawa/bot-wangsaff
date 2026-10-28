/**
 * GX-ID — /silent (owner only)
 *
 * Three levels, persisted as the `silentLevel` setting:
 *
 *   .silent off     → normal: the bot answers in full text
 *   .silent on      → suppress the gate/refusal notices (unknown command,
 *                     cooldown, owner-only, ban, unregistered group, …) while
 *                     successful commands still answer in text
 *   .silent super   → minimal: successful commands answer with a single 🟢
 *                     reaction and failures with 🔴 (🟡 when the outcome cannot
 *                     be decided, or for media-only output). The error template
 *                     is suppressed too.
 *
 * `.silent` with no argument reports the current level. The output minimisation
 * itself lives in `lib/reply-transform.js`.
 */
import {
  silentLevel,
  setSilentLevel,
  superSilent,
  emojiFor,
} from "../../lib/reply-transform.js";

const pluginConfig = {
  name: "silent",
  alias: ["silentmode", "hening", "bisukan"],
  category: "owner",
  description: "Atur mode silent: off (normal), on (sembunyikan notice gate), super (balas reaction saja)",
  usage: ".silent <off|on|super>",
  examples: [".silent off", ".silent on", ".silent super", ".silent"],
  helpOnEmpty: false,
  isOwner: true,
  cooldown: 3,
  isEnabled: true,
};

const OFF_WORDS = ["off", "disable", "disabled", "false", "tidak", "nonaktif", "0", "normal", "mati"];
const ON_WORDS = ["on", "enable", "enabled", "true", "ya", "aktif", "1", "nyala"];
const SUPER_WORDS = ["super", "minimal", "minim", "ultra", "max", "reaction", "reaksi"];

function label(level) {
  if (level === "super") return "SUPER";
  if (level === "on") return "ON";
  return "OFF";
}

function helpText(prefix) {
  return (
    `🔇 *Silent Mode*\n\n` +
    `> Status: *${label(silentLevel())}*\n\n` +
    `> \`${prefix}silent off\` — balasan teks normal\n` +
    `> \`${prefix}silent on\` — sembunyikan pesan penolakan/error\n` +
    `> \`${prefix}silent super\` — command sukses hanya dibalas reaction\n` +
    `>   ${emojiFor("ok")} sukses · ${emojiFor("fail")} gagal · ${emojiFor("info")} hasil lain\n`
  );
}

async function handler(m, { config }) {
  const prefix = m.prefix || config.command?.prefix || ".";
  const arg = (m.args[0] || "").toLowerCase();

  if (!arg) return m.reply(helpText(prefix));

  if (arg === "status") {
    return m.reply(helpText(prefix));
  }

  let level = null;
  if (SUPER_WORDS.includes(arg)) level = "super";
  else if (ON_WORDS.includes(arg)) level = "on";
  else if (OFF_WORDS.includes(arg)) level = "off";

  if (!level) return m.reply(helpText(prefix));

  /* already at this level? say so with the level's own minimalism */
  if (silentLevel() === level) {
    if (superSilent()) return m.react(emojiFor("ok"));
    return m.reply(`🔇 *Silent mode sudah ${label(level)}.*`);
  }

  setSilentLevel(level);

  /* The turn began under the OLD level, so a plain reply could still be treated
     as a super-mode toast. `keep` forces the confirmation through; the new level
     applies from the next command on. */
  if (level === "super") {
    return m.reply("🟢 *Silent mode SUPER.* Command sukses hanya dibalas reaction.", { keep: true });
  }
  if (level === "on") {
    return m.reply("🔇 *Silent mode ON.* Pesan penolakan/error tidak akan dikirim.", { keep: true });
  }
  return m.reply("🔊 *Silent mode OFF.* Balasan teks normal aktif kembali.", { keep: true });
}

export { pluginConfig as config, handler };
