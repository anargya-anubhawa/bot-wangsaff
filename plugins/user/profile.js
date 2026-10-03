/**
 * GX-ID — /profile (all)
 *
 * Shows a user's profile card: registration, message count, level (when the
 * group has levels on) and join date.
 */
import { resolveTarget, numberFromJid } from "../../lib/group-utils.js";

const pluginConfig = {
  name: "profile",
  alias: ["profil", "me", "myprofile"],
  category: "user",
  description: "Tampilkan profil pengguna",
  usage: ".profile [@user]",
  examples: [".profile", ".profile @user"],
  permission: "all",
  cooldown: 5,
  isEnabled: true,
};

function formatDate(iso) {
  if (!iso) return "-";
  try {
    return new Date(iso).toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" });
  } catch {
    return "-";
  }
}

async function handler(m, { db, config }) {
  const prefix = m.prefix || config.command?.prefix || ".";
  const target = resolveTarget(m) || m.sender;
  const user = db.getUser(target) || {};
  const level = m.isGroup ? db.getLevel(target, m.chat) : null;

  let text =
    `👤 *PROFIL*\n\n` +
    `╭─〔 user 〕\n` +
    `┃ Nama    : *${user.name || m.pushName || "-"}*\n` +
    `┃ Nomor   : @${numberFromJid(target)}\n` +
    `┃ Status  : ${user.isRegistered ? "✅ Terdaftar" : "❌ Belum terdaftar"}\n` +
    `┃ Daftar  : ${formatDate(user.registeredAt)}\n` +
    `┃ Pesan   : ${user.messageCount || 0}\n` +
    `╰─⬣`;

  if (level) {
    text += `\n\n╭─〔 level grup 〕\n┃ Level : *${level.level}*\n┃ XP    : *${level.xp}*\n╰─⬣`;
  } else if (m.isGroup) {
    text += `\n\n> _Sistem level belum aktif di grup ini._`;
  }
  text += `\n\n> ${user.isRegistered ? "" : `Daftar dulu: \`${prefix}daftar\``}`;

  await m.reply(text, { mentions: [target] });
}

export { pluginConfig as config, handler };
