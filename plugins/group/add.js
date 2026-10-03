/**
 * GX-ID — /add
 *
 * Add one or more members to a group. Works in a group (targets that group) or
 * in private (requires a group invite link). Mirrors the reference behaviour.
 */
import { botIsAdmin } from "../../lib/group-utils.js";

const pluginConfig = {
  name: "add",
  alias: ["addmember", "invite"],
  category: "group",
  description: "Add member(s) to a group",
  usage: ".add <number1> [number2] ... [group link]",
  example: ".add 6281234567890",
  isGroup: false,
  isPrivate: false,
  isAdmin: true,
  isBotAdmin: true,
  cooldown: 10,
  isEnabled: true,
};

async function handler(m, { sock, config }) {
  const prefix = m.prefix || config.command?.prefix || ".";
  const args = m.args || [];

  if (!args.length) {
    return m.reply(
      `👥 *ADD MEMBER*\n\n` +
        `> Usage:\n` +
        `> 1. In group: \`${prefix}add <number>\`\n` +
        `> 2. Multiple: \`${prefix}add <n1> <n2> ...\`\n` +
        `> 3. In private: \`${prefix}add <number> <group link>\`\n\n` +
        `> Requires: bot is admin and you are admin.`,
    );
  }

  let targetGroup = m.isGroup ? m.chat : null;
  const targetNumbers = [];

  for (const arg of args) {
    const linkMatch = arg.match(/chat\.whatsapp\.com\/([a-zA-Z0-9]+)/);
    if (linkMatch) {
      try {
        const info = await sock.groupGetInviteInfo(linkMatch[1]);
        targetGroup = info.id;
      } catch {
        return m.reply("❌ Invalid or expired group link.");
      }
    } else if (arg.includes("@g.us")) {
      targetGroup = arg;
    } else {
      let num = arg.replace(/[^0-9]/g, "");
      if (num.startsWith("0")) num = `62${num.slice(1)}`;
      if (num.length >= 10) targetNumbers.push(num);
    }
  }

  if (!targetNumbers.length) return m.reply("❌ Provide a valid number.");
  if (!targetGroup) {
    return m.reply(`❌ Run this in a group or include a group link.\n\n\`${prefix}add <number> <group link>\``);
  }

  const groupMeta = await sock.groupMetadata(targetGroup);
  if (!botIsAdmin(groupMeta, sock.user?.id)) {
    return m.reply(`❌ Bot is not an admin in *${groupMeta.subject}*.`);
  }

  if (!m.isGroup) {
    const senderNum = m.sender.split("@")[0];
    const senderParticipant = (groupMeta.participants || []).find(
      (p) => (p.jid || p.id || "").includes(senderNum),
    );
    if (!senderParticipant || !["admin", "superadmin"].includes(senderParticipant.admin)) {
      return m.reply(`❌ You are not an admin in *${groupMeta.subject}*.`);
    }
  }

  const valid = [];
  const already = [];
  for (const num of targetNumbers) {
    const exists = (groupMeta.participants || []).some(
      (p) => (p.id || "").includes(num) || (p.jid || "").includes(num),
    );
    if (exists) already.push(num);
    else valid.push(`${num}@s.whatsapp.net`);
  }

  if (!valid.length) return m.reply("❌ All numbers are already in the group.");

  await m.react("🕕");
  const results = await sock.groupParticipantsUpdate(targetGroup, valid, "add");

  const success = [];
  const invited = [];
  const failed = [];
  for (const res of results || []) {
    const num = res.content?.attrs?.phone_number?.replace("@s.whatsapp.net", "") || "";
    if (res.status === "200") success.push(num);
    else if (res.status === "408") invited.push(num);
    else failed.push({ num, status: res.status });
  }

  let text = `🥗 @${m.sender.split("@")[0]} added member(s) to *${groupMeta.subject}*\n\n`;
  if (success.length) text += `✅ *Added (${success.length}):*\n${success.map((n) => `• @${n}`).join("\n")}\n\n`;
  if (invited.length) text += `📨 *Invited (${invited.length}):*\n${invited.map((n) => `• @${n}`).join("\n")}\n\n`;
  if (failed.length) text += `❌ *Failed (${failed.length}):*\n${failed.map((f) => `• @${f.num} (${f.status})`).join("\n")}\n\n`;
  if (already.length) text += `⏭️ *Already in group (${already.length}):*\n${already.map((n) => `• @${n}`).join("\n")}`;

  await m.react(success.length || invited.length ? "✅" : "❌");
  await m.reply(text, {
    mentions: [
      ...success.map((n) => `${n}@s.whatsapp.net`),
      ...invited.map((n) => `${n}@s.whatsapp.net`),
      ...already.map((n) => `${n}@s.whatsapp.net`),
      m.sender,
    ],
  });
}

export { pluginConfig as config, handler };
