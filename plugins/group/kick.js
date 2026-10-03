/**
 * GX-ID — /kick
 */
import { resolveTarget, findParticipant, numberFromJid } from "../../lib/group-utils.js";

const pluginConfig = {
  name: "kick",
  alias: ["remove", "tendang"],
  category: "group",
  description: "Remove a member from the group",
  usage: ".kick @user",
  example: ".kick @user",
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
    return m.reply(`❌ *Target not found.*\n\n> Reply to a message or mention someone.\n> Example: \`${prefix}kick @user\``);
  }

  const botNumber = numberFromJid(sock.user?.id);
  const targetNumber = numberFromJid(target);

  if (targetNumber === botNumber) return m.reply("❌ Cannot kick the bot itself.");
  if (target === m.sender || targetNumber === numberFromJid(m.sender)) {
    return m.reply("❌ Cannot kick yourself.");
  }

  const participant = findParticipant(m.groupMetadata?.participants || [], target);
  if (!participant) return m.reply("❌ User not found in this group.");
  if (participant.admin) return m.reply("❌ Cannot kick a group admin.");

  const jid = participant.jid || participant.id || target;
  await sock.groupParticipantsUpdate(m.chat, [jid], "remove");
  await m.reply(`✅ @${numberFromJid(jid)} has been removed from the group.`, { mentions: [jid] });
}

export { pluginConfig as config, handler };
