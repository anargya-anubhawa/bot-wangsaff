/**
 * GX-ID — /antivirtexdm (owner)
 *
 * Global toggle: when on, virtex-like private messages are reported to the
 * owner instead of being ignored. Owner/whitelist senders are exempt.
 */
const pluginConfig = {
  name: "antivirtexdm",
  alias: ["virtexdm", "antivirtexprivate"],
  category: "security",
  description: "Laporkan pesan virtex di chat pribadi ke owner",
  usage: ".antivirtexdm <on|off>",
  examples: [".antivirtexdm on"],
  helpOnEmpty: false,
  permission: "owner",
  cooldown: 5,
  isEnabled: true,
};

function parse(arg) {
  const v = String(arg || "").toLowerCase();
  if (["on", "yes", "enable", "aktif", "1", "true"].includes(v)) return true;
  if (["off", "no", "disable", "mati", "0", "false"].includes(v)) return false;
  return null;
}

async function handler(m, { db, config }) {
  const prefix = m.prefix || config.command?.prefix || ".";
  const state = parse(m.args?.[0]);
  if (state === null) {
    const current = !!db.setting("antivirtexdm");
    return m.reply(`🧨 *Antivirtex DM*: ${current ? "✅ ON" : "❌ OFF"}\n\n> Usage: \`${prefix}antivirtexdm <on|off>\``);
  }
  db.setting("antivirtexdm", state);
  await m.reply(`✅ Antivirtex DM ${state ? "diaktifkan" : "dinonaktifkan"}.`);
}

export { pluginConfig as config, handler };
