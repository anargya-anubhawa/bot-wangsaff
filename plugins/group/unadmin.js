/**
 * GX-ID — /unadmin (admin, bot-admin)
 *
 * Demotes one or more admins back to member. Alias-compatible with `.demote`.
 */
import { resolveTarget, findParticipant, numberFromJid, normalizeToJid } from "../../lib/group-utils.js";
import { demoteFromAdmin } from "../../lib/group-service.js";
import { ensureBotAdmin, BOT_NOT_ADMIN } from "../../lib/plugin-utils.js";

const pluginConfig = {
  name: "unadmin",
  alias: ["turunkanadmin", "removeadmin"],
  category: "group",
  description: "Turunkan admin menjadi anggota biasa",
  usage: ".unadmin @user",
  examples: [".unadmin @user"],
  permission: "admin",
  isBotAdmin: true,
  cooldown: 5,
  isEnabled: true,
};

function collectTargets(m) {
  const jids = new Set();
  const replyTarget = resolveTarget(m);
  if (replyTarget) {
    const participant = findParticipant(m.groupMetadata?.participants || [], replyTarget);
    jids.add(participant?.jid || participant?.id || replyTarget);
  }
  for (const jid of m.mentionedJid || []) jids.add(jid);
  for (const arg of m.args || []) {
    if (arg.startsWith("@") || /^[0-9+\-\s]{8,}$/.test(arg)) {
      const jid = normalizeToJid(arg);
      if (jid) jids.add(jid);
    }
  }
  return [...jids];
}

async function handler(m, { sock, config }) {
  const prefix = m.prefix || config.command?.prefix || ".";
  const targets = collectTargets(m);
  if (!targets.length) {
    return m.reply(`❌ *Target tidak ditemukan.*\n\n> Balas pesan atau mention seseorang.\n> Contoh: \`${prefix}unadmin @user\``);
  }
  if (!(await ensureBotAdmin(m, sock))) return m.reply(BOT_NOT_ADMIN);

  await demoteFromAdmin(sock, m.chat, targets);
  await m.reply(`✅ ${targets.map((t) => `@${numberFromJid(t)}`).join(", ")} diturunkan menjadi anggota biasa.`, { mentions: targets });
}

export { pluginConfig as config, handler };
