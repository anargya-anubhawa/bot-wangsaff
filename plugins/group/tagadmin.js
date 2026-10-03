/**
 * GX-ID — /tagadmin
 *
 * Tags only the group admins.
 */
import { getParticipantJid, getParticipantJids } from "../../lib/lid.js";

const pluginConfig = {
  name: "tagadmin",
  alias: ["listadmin", "adminlist", "tagadmins"],
  category: "group",
  description: "Tag all group admins",
  usage: ".tagadmin <message>",
  example: ".tagadmin Meeting at 8pm",
  helpOnEmpty: false,
  isGroup: true,
  isAdmin: true,
  cooldown: 15,
  isEnabled: true,
};

async function handler(m, { sock }) {
  const text = m.text || "Attention admins!";
  const admins = (m.groupMetadata?.participants || []).filter((p) => p.admin);
  if (!admins.length) return m.reply("❌ No admins found.");

  const mentions = getParticipantJids(admins);
  const list = admins.map((p) => `@${getParticipantJid(p).split("@")[0]}`).join("\n");

  await sock.sendMessage(
    m.chat,
    { text: `*Message:* ${text}\n\n\`\`\`━━━ ${admins.length} ADMINS ━━━\`\`\`\n${list}`, mentions },
    { quoted: m.raw },
  );
}

export { pluginConfig as config, handler };
