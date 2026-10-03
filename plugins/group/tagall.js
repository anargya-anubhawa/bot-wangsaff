/**
 * GX-ID — /tagall
 */
import { getParticipantJid, getParticipantJids } from "../../lib/lid.js";

const pluginConfig = {
  name: "tagall",
  alias: ["all", "everyone"],
  category: "group",
  description: "Tag every member in the group",
  usage: ".tagall <message>",
  example: ".tagall Hello everyone!",
  helpOnEmpty: false,
  isGroup: true,
  isAdmin: true,
  cooldown: 30,
  isEnabled: true,
};

async function handler(m, { sock }) {
  const text = m.text || "Tag All Members";
  const participants = m.groupMetadata?.participants || [];
  if (!participants.length) return m.reply("❌ No members found in this group.");

  const targets = participants.filter((p) => getParticipantJid(p) !== m.sender);
  if (!targets.length) return m.reply("❌ No other members to tag.");

  const mentions = getParticipantJids(targets);
  const memberList = targets.map((p) => `@${getParticipantJid(p).split("@")[0]}`).join("\n");

  await sock.sendMessage(
    m.chat,
    {
      text: `*Message:* ${text}\n\n\`\`\`━━━ ${targets.length} MEMBERS ━━━\`\`\`\n${memberList}`,
      mentions,
    },
    { quoted: m.raw },
  );
}

export { pluginConfig as config, handler };
