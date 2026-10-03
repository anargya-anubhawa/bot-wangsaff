/**
 * GX-ID — /allowadmin (owner)
 *
 * Toggles whether group admins may use bot commands in this group
 * (default: on). Owner/whitelist always retain access.
 */
const pluginConfig = {
  name: "allowadmin",
  alias: ["admincmd", "izinkanadmin"],
  category: "bot-config",
  description: "Izinkan/larang admin grup memakai perintah bot di grup ini",
  usage: ".allowadmin <on|off>",
  examples: [".allowadmin off", ".allowadmin on"],
  helpOnEmpty: false,
  permission: "owner",
  isGroup: true,
  cooldown: 3,
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
    const current = (db.getGroup(m.chat) || {}).allowAdminCommands !== false;
    return m.reply(`🛡️ *Allow Admin*: ${current ? "✅ ON" : "❌ OFF"}\n\n> Usage: \`${prefix}allowadmin <on|off>\``);
  }
  db.setGroup(m.chat, { allowAdminCommands: state });
  await m.reply(`✅ Admin grup ${state ? "sekarang bisa" : "tidak lagi bisa"} memakai perintah bot di sini.`);
}

export { pluginConfig as config, handler };
