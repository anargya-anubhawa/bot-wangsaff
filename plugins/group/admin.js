/**
 * GX-ID — /admin (admin, bot-admin)
 *
 * Promotes one or more members to admin. Alias-compatible with `.promote`,
 * but accepts multiple targets and a trailing group id for linked groups.
 */
import { resolveTarget, findParticipant, numberFromJid, normalizeToJid } from "../../lib/group-utils.js";
import { promoteToAdmin } from "../../lib/group-service.js";
import { ensureBotAdmin, BOT_NOT_ADMIN } from "../../lib/plugin-utils.js";

const pluginConfig = {
  name: "admin",
  alias: ["jadikanadmin", "makeadmin"],
  category: "group",
  description: "Jadikan anggota sebagai admin grup",
  usage: ".admin @user",
  examples: [".admin @user"],
  permission: "admin",
  isBotAdmin: true,
  cooldown: 5,
  isEnabled: true,
};

/** Collect target JIDs from mentions, a reply, or trailing numbers. */
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
    return m.reply(`❌ *Target tidak ditemukan.*\n\n> Balas pesan atau mention seseorang.\n> Contoh: \`${prefix}admin @user\``);
  }
  if (!(await ensureBotAdmin(m, sock))) return m.reply(BOT_NOT_ADMIN);

  await promoteToAdmin(sock, m.chat, targets);
  await m.reply(`✅ ${targets.map((t) => `@${numberFromJid(t)}`).join(", ")} dijadikan admin.`, { mentions: targets });
}

export { pluginConfig as config, handler };
