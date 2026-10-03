/**
 * GX-ID — case system
 *
 * A lightweight complement to the plugin system: commands that are simpler to
 * implement inline (no separate file) live here. Handled before plugin
 * dispatch. Mirrors the reference architecture's `case/` module.
 */
import { performance } from "perf_hooks";
import { getCategories, getCommandsByCategory, getPlugin } from "../lib/plugins.js";
import config from "../config.js";
import { toSmallCaps } from "../lib/formatter.js";
import { saluranCtx } from "../lib/context.js";

const CATEGORY_EMOJIS = {
  owner: "👑",
  main: "🏠",
  utility: "🔧",
  tools: "🛠️",
  fun: "🎮",
  game: "🎯",
  group: "👥",
  info: "ℹ️",
  sticker: "🖼️",
  media: "🎬",
  search: "🔍",
  download: "📥",
  user: "📊",
  notes: "📝",
};

const CASE_COMMANDS = {
  info: ["cping", "listallcase", "listallplugin"],
};

const CASE_ALIASES = {
  cping: ["cspeed", "clatency"],
  listallcase: ["lcase", "caselist", "allcase"],
  listallplugin: ["lplugin", "pluginlist", "allplugin"],
};

function withChannel(text) {
  return { text, contextInfo: saluranCtx() };
}

async function handleCommand(m, sock) {
  if (!m.isCommand) return { handled: false };
  const command = m.command?.toLowerCase();
  if (!command) return { handled: false };
  const prefix = m.prefix || config.command?.prefix || ".";

  try {
    switch (command) {
      case "cping":
      case "cspeed":
      case "clatency": {
        const start = performance.now();
        await m.react("🕕");
        const msgTimestamp = m.timestamp ? Number(m.timestamp) * 1000 : Date.now();
        const latency = Math.max(1, Date.now() - msgTimestamp);
        const processTime = (performance.now() - start).toFixed(2);
        let status = "🟢 Excellent";
        if (latency > 100 && latency <= 300) status = "🟡 Good";
        else if (latency > 300) status = "🔴 Poor";
        const text =
          `⚡ *CASE SYSTEM PING*\n\n` +
          `╭┈┈⬡「 📊 *status* 」\n` +
          `┃ ◦ Latency : *${latency}ms*\n` +
          `┃ ◦ Process : *${processTime}ms*\n` +
          `┃ ◦ Status  : ${status}\n` +
          `╰┈┈⬡`;
        await m.reply(text);
        await m.react("✅");
        return { handled: true };
      }

      case "lcase":
      case "caselist":
      case "allcase":
      case "listallcase": {
        await m.react("🔍");
        let total = 0;
        for (const cat in CASE_COMMANDS) total += CASE_COMMANDS[cat].length;
        let text = `╔══════════════════╗\n`;
        text += `   📦 *${toSmallCaps("CASE LIST")}*\n`;
        text += `╚══════════════════╝\n\n`;
        text += `╭┈┈⬡「 📊 *info* 」\n`;
        text += `┃ ◦ Total    : *${total}* cases\n`;
        text += `┃ ◦ Category : *${Object.keys(CASE_COMMANDS).length}*\n`;
        text += `╰┈┈⬡\n\n`;
        for (const category in CASE_COMMANDS) {
          const emoji = CATEGORY_EMOJIS[category] || "📌";
          text += `╭┈┈⬡「 ${emoji} *${toSmallCaps(category)}* 」\n`;
          CASE_COMMANDS[category].forEach((cmd, i) => {
            const alias = CASE_ALIASES[cmd] ? ` (${CASE_ALIASES[cmd].slice(0, 2).join(", ")})` : "";
            text += `┃ ${i + 1}. ${prefix}${cmd}${alias}\n`;
          });
          text += `╰┈┈⬡\n\n`;
        }
        text += `*━━━━━━━━━━━━━━━*\n`;
        text += `💡 *tip:* use \`${prefix}listallplugin\` to see plugins`;
        await sock.sendMessage(m.chat, withChannel(text), { quoted: m.raw });
        await m.react("✅");
        return { handled: true };
      }

      case "lplugin":
      case "pluginlist":
      case "allplugin":
      case "listallplugin": {
        await m.react("🔍");
        const categories = getCategories();
        const commandsByCategory = getCommandsByCategory();
        let total = 0;
        for (const cat of categories) total += (commandsByCategory[cat] || []).length;
        if (total === 0) {
          await m.reply("⚠️ *No plugins loaded yet.*");
          return { handled: true };
        }
        let text = `╔══════════════════╗\n`;
        text += `   🔌 *${toSmallCaps("PLUGIN LIST")}*\n`;
        text += `╚══════════════════╝\n\n`;
        text += `╭┈┈⬡「 📊 *info* 」\n`;
        text += `┃ ◦ Total    : *${total}* plugins\n`;
        text += `┃ ◦ Category : *${categories.length}*\n`;
        text += `╰┈┈⬡\n\n`;
        for (const category of [...categories].sort()) {
          const commands = commandsByCategory[category] || [];
          if (!commands.length) continue;
          const emoji = CATEGORY_EMOJIS[category] || "📌";
          text += `╭┈┈⬡「 ${emoji} *${toSmallCaps(category)}* 」\n`;
          [...commands].sort().forEach((cmd, i) => {
            const plugin = getPlugin(cmd);
            const alias =
              plugin?.config?.alias && plugin.config.alias.length
                ? ` (${plugin.config.alias.slice(0, 2).join(", ")})`
                : "";
            text += `┃ ${i + 1}. ${prefix}${cmd}${alias}\n`;
          });
          text += `╰┈┈⬡\n\n`;
        }
        text += `*━━━━━━━━━━━━━━━*\n`;
        text += `💡 *tip:* use \`${prefix}listallcase\` to see cases`;
        await sock.sendMessage(m.chat, withChannel(text), { quoted: m.raw });
        await m.react("✅");
        return { handled: true };
      }

      default:
        return { handled: false };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? "Unknown error");
    return { handled: true, error: message };
  }
}

function getCaseCommands() {
  return CASE_COMMANDS;
}

function getCaseCount() {
  let total = 0;
  for (const category in CASE_COMMANDS) total += CASE_COMMANDS[category].length;
  return total;
}

function getCaseCategories() {
  return Object.keys(CASE_COMMANDS);
}

function getCasesByCategory() {
  return CASE_COMMANDS;
}

export { handleCommand, getCaseCommands, getCaseCount, getCaseCategories, getCasesByCategory };
