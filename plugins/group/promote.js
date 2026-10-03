/**
 * GX-ID — /promote
 */
import { resolveTarget, findParticipant, numberFromJid } from "../../lib/group-utils.js";

const pluginConfig = {
  name: "promote",
  alias: ["jadiadmin", "naikadmin"],
  category: "group",
  description: "Promote a member to admin",
  usage: ".promote @user",
  example: ".promote @user",
  isGroup: true,
  isAdmin: true,
  isBotAdmin: true,
  cooldown: 5,
  isEnabled: true,
};

async function handler(m, { sock, config }) {
  const prefix = m.prefix || config.command?.prefix || ".";
  const target = resolveTarget(m);
  if (!target) {
    return m.reply(`❌ *Target not found.*\n\n> Reply to a message or mention someone.\n> Example: \`${prefix}promote @user\``);
  }

  const participant = findParticipant(m.groupMetadata?.participants || [], target);
  if (!participant) return m.reply("❌ User not found in this group.");
  if (participant.admin) return m.reply("❌ User is already an admin.");

  const jid = participant.jid || participant.id || target;
  await sock.groupParticipantsUpdate(m.chat, [jid], "promote");
  await m.reply(`✅ @${numberFromJid(jid)} is now an admin.`, { mentions: [jid] });
}

export { pluginConfig as config, handler };
