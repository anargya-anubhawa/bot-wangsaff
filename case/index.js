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
import { beginTurn, finishTurn, markDelivered } from "../lib/reply-transform.js";

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

async function handleCase(m, sock) {
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
        let status = "Excellent";
        if (latency > 100 && latency <= 300) status = "Good";
        else if (latency > 300) status = "Poor";
        const text =
          `*CASE SYSTEM PING*\n\n` +
          `╭┈┈⬡「 *status* 」\n` +
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
        text += `   *${toSmallCaps("CASE LIST")}*\n`;
        text += `╚══════════════════╝\n\n`;
        text += `╭┈┈⬡「 *info* 」\n`;
        text += `┃ ◦ Total    : *${total}* cases\n`;
        text += `┃ ◦ Category : *${Object.keys(CASE_COMMANDS).length}*\n`;
        text += `╰┈┈⬡\n\n`;
        for (const category in CASE_COMMANDS) {
          text += `╭┈┈⬡「 *${toSmallCaps(category)}* 」\n`;
          CASE_COMMANDS[category].forEach((cmd, i) => {
            const alias = CASE_ALIASES[cmd] ? ` (${CASE_ALIASES[cmd].slice(0, 2).join(", ")})` : "";
            text += `┃ ${i + 1}. ${prefix}${cmd}${alias}\n`;
          });
          text += `╰┈┈⬡\n\n`;
        }
        text += `*━━━━━━━━━━━━━━━*\n`;
        text += `Tip: use \`${prefix}listallplugin\` to see plugins`;
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
          await m.reply("*No plugins loaded yet.*");
          return { handled: true };
        }
        let text = `╔══════════════════╗\n`;
        text += `   *${toSmallCaps("PLUGIN LIST")}*\n`;
        text += `╚══════════════════╝\n\n`;
        text += `╭┈┈⬡「 *info* 」\n`;
        text += `┃ ◦ Total    : *${total}* plugins\n`;
        text += `┃ ◦ Category : *${categories.length}*\n`;
        text += `╰┈┈⬡\n\n`;
        for (const category of [...categories].sort()) {
          const commands = commandsByCategory[category] || [];
          if (!commands.length) continue;
          text += `╭┈┈⬡「 *${toSmallCaps(category)}* 」\n`;
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
        text += `Tip: use \`${prefix}listallcase\` to see cases`;
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

/**
 * Run the case system inside its own output turn, so the reply transformer
 * (super silent mode / automatic ✅) sees its output too.
 *
 * IMPORTANT: the case system runs for EVERY command, before plugin dispatch.
 * When it does not handle the command it must return WITHOUT finalising the
 * turn — otherwise it would emit a summary (e.g. an auto-✅) for a command that
 * has not run yet, and the plugin's own turn would find the state consumed.
 *
 * Case commands send through the socket directly, so they mark delivery by hand.
 *
 * @returns {Promise<{handled:boolean, error?:string}>}
 */
async function handleCommand(m, sock) {
  const result = await handleCase(m, sock);
  if (!result?.handled) return result;

  beginTurn(m);
  markDelivered(m, result.error ? "fail" : "ok");
  await finishTurn(m, result.error ? false : true);
  return result;
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
