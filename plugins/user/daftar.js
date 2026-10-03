/**
 * GX-ID — /daftar (all)
 *
 * Registers the sender in the bot's user database (idempotent). Useful as a
 * lightweight "sign up" step and to ensure a profile exists for `.profile`.
 */
const pluginConfig = {
  name: "daftar",
  alias: ["register", "signup", "daftaruser"],
  category: "user",
  description: "Daftarkan dirimu ke database bot",
  usage: ".daftar [nama]",
  examples: [".daftar Budi"],
  permission: "all",
  isPrivate: false,
  cooldown: 5,
  isEnabled: true,
};

async function handler(m, { db, config }) {
  const prefix = m.prefix || config.command?.prefix || ".";
  const user = db.getUser(m.sender);
  const name = (m.text || "").trim() || m.pushName || "User";

  if (user?.isRegistered) {
    return m.reply(`ℹ️ Kamu sudah terdaftar, @${m.sender.split("@")[0]}.\n\n> Lihat profil: \`${prefix}profile\``, {
      mentions: [m.sender],
    });
  }

  db.setUser(m.sender, { isRegistered: true, name, registeredAt: new Date().toISOString() });
  await m.reply(`✅ *Terdaftar!*\n\n> Nama: *${name}*\n> ID: \`${m.sender.split("@")[0]}\``);
}

export { pluginConfig as config, handler };
