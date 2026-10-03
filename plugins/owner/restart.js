/**
 * GX-ID — /restart (owner only)
 *
 * Restarts the whole bot process. Everything is flushed first (database, socket
 * presence) and the process is then relaunched — either by the active supervisor
 * (pm2 / `node --watch`) or by a detached replacement spawned by
 * `lib/restart.js`. Use `.reload` when only plugins changed; restart is for
 * `.env` / `config.js` changes, which are only read at import time.
 *
 * Usage:
 *   .restart           → restart the bot
 *   .restart status    → show how the restart would be performed
 */
import { restartBot, isWatchMode, isUnderSupervisor, isRestarting } from "../../lib/restart.js";

const pluginConfig = {
  name: "restart",
  alias: ["reboot", "restartbot", "rebootbot"],
  category: "owner",
  description: "Restart bot untuk menerapkan perubahan config / .env",
  usage: ".restart [status]",
  examples: [".restart", ".restart status"],
  parameters: [{ name: "status", description: "Tampilkan mode restart tanpa menjalankan" }],
  helpOnEmpty: false,
  permission: "owner",
  cooldown: 0,
  isEnabled: true,
};

function restartMode() {
  if (isWatchMode()) return "node --watch (auto)";
  if (isUnderSupervisor()) return "supervisor (pm2)";
  return "relaunch (proses baru)";
}

async function handler(m, { config }) {
  const prefix = m.prefix || config.command?.prefix || ".";
  const sub = (m.args[0] || "").toLowerCase();

  if (sub === "status") {
    return m.reply(
      `⚙️ *Restart*\n\n> Mode    : *${restartMode()}*\n> Berjalan: *${isRestarting() ? "ya" : "tidak"}*`,
    );
  }

  await m.reply(`♻️ _Bot akan restart…_ (${restartMode()})`).catch(() => {});
  // Give the reply a moment to reach WhatsApp before the socket is torn down.
  setTimeout(() => {
    restartBot({ reason: `command by ${m.pushName || m.sender}` }).catch(() => process.exit(0));
  }, 1500);
  return undefined;
}

export { pluginConfig as config, handler };
