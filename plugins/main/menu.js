/**
 * VEA — /menu  (alias: /help, /m)
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
import { saluranCtx, interactiveContextInfo, sendLinkPreview } from "../../lib/context.js";
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
    const emoji = config.ui?.menuCategoryIcons === true ? categoryEmoji(cat) : "";
    rows.push({
      title: `${emoji ? `${emoji} ` : ""}${categoryLabel(cat).toUpperCase()}`,
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
    `╭─〔 *${toSmallCaps("Menu")}* 〕`,
    `┃ ${toSmallCaps("Name")}    : ${m.pushName || "User"}`,
    `┃ ${toSmallCaps("Role")}    : ${role}`,
    `┃ ${toSmallCaps("Bot")}     : ${config.bot?.name || "VEA"}`,
    `┃ ${toSmallCaps("Version")} : ${config.bot?.version || "1.0.0"}`,
    `┃ ${toSmallCaps("Mode")}    : ${(config.mode || "public").toUpperCase()}`,
    `┃ ${toSmallCaps("Uptime")}  : ${formatUptime(uptime)}`,
    `┃ ${toSmallCaps("Features")}: ${totalFeatures}`,
    `╰─⬣`,
    ``,
    `*Select a category below to view available commands.*`,
    ``,
    `*To display the full menu, you can select the _"Show All Menu"_ button or type the command _.allmenu_*`,
  ];
  const body = bodyLines.join("\n");

  /* banner photo: prefer the image the user replied with, else the dedicated
     banner asset, else the menu asset. */
  let bannerImage = await getImageBuffer("banner", config.bot?.name || "VEA").catch(() => null);
  if (!bannerImage || !config.assets?.banner) {
    bannerImage = await getImageBuffer("menu", config.bot?.name || "VEA").catch(() => null);
  }
  if (m.quoted?.isImage) {
    const replied = await m.quoted.download().catch(() => null);
    if (replied) bannerImage = replied;
  }

  /* message 1 — body as a WhatsApp-style link preview card (banner thumbnail,
     title, description) whose link opens the channel URL from `.env`. */
  await sendLinkPreview(sock, m, {
    text: body,
    title: config.bot?.name || "VEA",
    description: config.channel?.name || "",
    thumbnail: bannerImage,
  });

  try {
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
                hasMediaAttachment: false,
              },
              body: { text: `*Select a category below to view available commands.*` },
              footer: { text: `${config.bot?.name || "VEA"} by ${config.owner?.name || "Owner"}` },
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
    /* interactive send failed — fall back to plain image/text caption. If the
       banner already carried the body above, only the buttonless text remains. */
    logger.warn(`[FALLBACK] using legacy menu: ${error.message}`);
    await m.reply(body, { keep: true });
  }
}

export { pluginConfig as config, handler };
