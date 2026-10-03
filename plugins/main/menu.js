/**
 * GX-ID — /menu  (alias: /help, /m)
 *
 * Main menu. Renders one image bubble carrying a single `single_select`
 * category list (the usual style) via relayMessage — upstream Baileys v7 has
 * no sendMessage interactive support. Tapping a category row dispatches the
 * category command (`.allmenu <category>`), which opens that category's
 * command list. Falls back to a plain image/text caption if the interactive
 * send fails.
 */
import { getCaseCount, getCasesByCategory } from "../../case/index.js";
import { getCategories, getCommandsByCategory } from "../../lib/plugins.js";
import { getImageBuffer } from "../../lib/asset-manager.js";
import { formatUptime, toSmallCaps } from "../../lib/formatter.js";
import { getTimeGreeting } from "../../lib/time.js";
import { saluranCtx, interactiveContextInfo } from "../../lib/context.js";
import { interactiveRelayNodes } from "../../lib/socket.js";
import { logger } from "../../lib/logger.js";
import { categoryEmoji, categoryLabel, visibleCategories } from "./category.js";

const pluginConfig = {
  name: "menu",
  alias: ["bantuan", "commands", "m"],
  category: "main",
  description: "Show the main menu",
  usage: ".menu",
  example: ".menu",
  isOwner: false,
  isGroup: false,
  isPrivate: false,
  cooldown: 5,
  isEnabled: true,
};

async function handler(m, { sock, config, db, uptime }) {
  const prefix = m.prefix || config.command?.prefix || ".";
  const commandsByCategory = getCommandsByCategory();
  const casesByCategory = getCasesByCategory();
  const totalCases = getCaseCount();

  const categories = visibleCategories(
    [...new Set([...getCategories(), ...Object.keys(casesByCategory)])],
    { isOwner: m.isOwner },
  );
  const rows = [];
  let totalCommands = 0;

  for (const cat of categories) {
    const pluginCmds = commandsByCategory[cat] || [];
    const caseCmds = casesByCategory[cat] || [];
    const count = pluginCmds.length + caseCmds.length;
    totalCommands += count;
    if (!count) continue;
    const emoji = categoryEmoji(cat);
    rows.push({
      title: `${emoji} ${categoryLabel(cat).toUpperCase()}`,
      description: `${count} command${count > 1 ? "s" : ""}`,
      id: `${prefix}allmenu ${cat}`,
    });
  }

  const totalFeatures = totalCommands + totalCases;
  const greeting = getTimeGreeting();
  const user = db.getUser(m.sender) || {};
  const role = m.isOwner ? "Owner" : user.isPremium ? "Premium" : "User";

  const bodyLines = [
    `${greeting}`,
    ``,
    `✨━━━〔 *${toSmallCaps("Menu")}* 〕━━━✨`,
    ``,
    `➤ ${toSmallCaps("Name")} : *${m.pushName || "User"}*`,
    `➤ ${toSmallCaps("Role")} : *${role}*`,
    `➤ ${toSmallCaps("Bot")} : *${config.bot?.name || "GX-ID"}*`,
    `➤ ${toSmallCaps("Version")} : *${config.bot?.version || "1.0.0"}*`,
    `➤ ${toSmallCaps("Mode")} : *${(config.mode || "public").toUpperCase()}*`,
    `➤ ${toSmallCaps("Uptime")} : *${formatUptime(uptime)}*`,
    `➤ ${toSmallCaps("Features")} : *${totalFeatures}*`,
    ``,
    `*Select a category below to view available commands.*`,
    ``,
    `*To display the full menu, you can select the _"Show All Menu"_ button or type the command _.allmenu_*`,
  ];
  const body = bodyLines.join("\n");

  const imageBuffer = await getImageBuffer("menu", config.bot?.name || "GX-ID").catch(() => null);

  try {
    const media = imageBuffer ? await sock.prepareMedia({ image: imageBuffer }) : null;
    await sock.relayMessage(
      m.chat,
      {
        viewOnceMessage: {
          message: {
            messageContextInfo: interactiveContextInfo(),
            interactiveMessage: {
              header: {
                title: "",
                subtitle: "",
                hasMediaAttachment: !!media?.imageMessage,
                ...(media?.imageMessage ? { imageMessage: media.imageMessage } : {}),
              },
              body: { text: body },
              footer: { text: `${config.bot?.name || "GX-ID"} by ${config.owner?.name || "Owner"}` },
              contextInfo: {
                ...saluranCtx(),
                mentionedJid: [m.sender],
              },
              nativeFlowMessage: {
                buttons: [
                  {
                    name: "single_select",
                    buttonParamsJson: JSON.stringify({
                      title: "Select Menu",
                      sections: [{ title: "Categories", rows }],
                    }),
                  },
                  {
                    name: "quick_reply",
                    buttonParamsJson: JSON.stringify({
                      display_text: "Show All Menu",
                      id: `${prefix}allmenu`,
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
  } catch (error) {
    /* interactive send failed — fall back to plain image/text caption */
    logger.warn(`[FALLBACK] using legacy menu: ${error.message}`);
    if (imageBuffer) {
      await sock
        .sendMessage(m.chat, { image: imageBuffer, caption: body, contextInfo: saluranCtx() }, { quoted: m.raw })
        .catch(async () => {
          await m.reply(body);
        });
    } else {
      await m.reply(body);
    }
  }
}

export { pluginConfig as config, handler };
