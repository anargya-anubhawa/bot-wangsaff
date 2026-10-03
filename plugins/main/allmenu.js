/**
 * GX-ID — /allmenu
 *
 * Shows the commands of a single category, and (without arguments) lists all
 * categories. Uses the same interactive relayMessage mechanism as /menu.
 */
import { getCasesByCategory } from "../../case/index.js";
import { getCategories, getCommandsByCategory, getPlugin } from "../../lib/plugins.js";
import { getImageBuffer } from "../../lib/asset-manager.js";
import { toSmallCaps } from "../../lib/formatter.js";
import { saluranCtx, interactiveContextInfo } from "../../lib/context.js";
import { interactiveRelayNodes } from "../../lib/socket.js";
import { categoryEmoji, categoryLabel, isCategoryVisible, visibleCategories } from "./category.js";

const pluginConfig = {
  name: "allmenu",
  alias: ["am", "category", "cat"],
  category: "main",
  description: "Show commands in a category",
  usage: ".allmenu <category>",
  example: ".allmenu group",
  helpOnEmpty: false,
  isOwner: false,
  isGroup: false,
  isPrivate: false,
  cooldown: 3,
  isEnabled: true,
};

function commandSymbols(cmd) {
  const plugin = getPlugin(cmd);
  if (!plugin?.config) return "";
  const s = [];
  if (plugin.config.isOwner) s.push("Ⓞ");
  if (plugin.config.isPremium) s.push("ⓟ");
  if (plugin.config.isAdmin) s.push("Ⓐ");
  if (plugin.config.isGroup) s.push("Ⓖ");
  if (plugin.config.isPrivate) s.push("Ⓟ");
  return s.length ? ` ${s.join(" ")}` : "";
}

function box(emoji, title, lines) {
  let text = `╭─〔 ${emoji} \`${title}\`\n`;
  for (const line of lines) text += `┃ ${line}\n`;
  text += `╰─⬣\n\n`;
  return text;
}

async function sendInteractive(sock, m, config, text, extraButtons = []) {
  const imageBuffer = await getImageBuffer("menu", config.bot?.name || "GX-ID");
  const media = await sock.prepareMedia({ image: imageBuffer });
  await sock.relayMessage(
    m.chat,
    {
      viewOnceMessage: {
        message: {
          messageContextInfo: interactiveContextInfo(),
          interactiveMessage: {
            header: { title: "", subtitle: "", hasMediaAttachment: true, imageMessage: media.imageMessage },
            body: { text },
            footer: { text: "Select a button below" },
            contextInfo: { ...saluranCtx(), mentionedJid: [m.sender] },
            nativeFlowMessage: {
              buttons: [
                ...extraButtons,
                {
                  name: "quick_reply",
                  buttonParamsJson: JSON.stringify({
                    display_text: "Back to Main Menu",
                    id: `${m.prefix}menu`,
                  }),
                },
              ],
            },
          },
        },
      },
    },
    { quoted: m.raw, additionalNodes: interactiveRelayNodes(m.chat) },
  );
}

async function handler(m, { sock, config }) {
  const prefix = m.prefix || config.command?.prefix || ".";
  const categoryArg = (m.args[0] || "").toLowerCase();
  const commandsByCategory = getCommandsByCategory();
  const casesByCategory = getCasesByCategory();

  const allCategories = [...new Set([...getCategories(), ...Object.keys(casesByCategory)])];

  /* no argument — list categories */
  if (!categoryArg) {
    let text = `╭─〔 📖 \`legend\`\n`;
    for (const line of [
      "Ⓞ = owner only",
      "ⓟ = premium only",
      "Ⓐ = admin only",
      "Ⓖ = group only",
      "Ⓟ = private only",
    ]) {
      text += `┃ ${line}\n`;
    }
    text += `╰─⬣\n\n`;
    const categories = visibleCategories(allCategories, { isOwner: m.isOwner });
    for (const cat of categories) {
      const cmds = [...(commandsByCategory[cat] || []), ...(casesByCategory[cat] || [])];
      if (!cmds.length) continue;
      const emoji = categoryEmoji(cat);
      text += box(emoji, toSmallCaps(categoryLabel(cat)), cmds.map((c) => `${prefix}${c}${commandSymbols(c)}`));
    }
    try {
      await sendInteractive(sock, m, config, text);
    } catch {
      await m.reply(text);
    }
    return;
  }

  const matched = allCategories.find((c) => c.toLowerCase() === categoryArg);
  if (!matched) {
    return m.reply(
      `*Category not found.*\n\n> \`${categoryArg}\` does not exist.\n> Send \`${prefix}allmenu\` to list categories.`,
    );
  }
  if (!isCategoryVisible(matched, { isOwner: m.isOwner })) {
    return m.reply("*Access denied.* This category is owner-only.");
  }

  const pluginCmds = commandsByCategory[matched] || [];
  const caseCmds = casesByCategory[matched] || [];
  const allCmds = [...pluginCmds, ...caseCmds];
  if (!allCmds.length) {
    return m.reply(`Category \`${matched}\` has no commands.`);
  }

  const emoji = categoryEmoji(matched);
  let text = box(emoji, toSmallCaps(categoryLabel(matched)), allCmds.map((c) => `${prefix}${c}${commandSymbols(c)}`));
  text += `Total: \`${allCmds.length}\` commands`;

  try {
    await sendInteractive(sock, m, config, text, [
      {
        name: "quick_reply",
        buttonParamsJson: JSON.stringify({
          display_text: "Back to Categories",
          id: `${m.prefix}allmenu`,
        }),
      },
    ]);
  } catch {
    await m.reply(text);
  }
}

export { pluginConfig as config, handler };
