/**
 * GX-ID — lifecycle notices (bot online / shutting down)
 *
 * Posts a short notice to the owner's *management panel* — the global default
 * log panel (`defaultLogPanel`, set with `.log default`) — when the bot becomes
 * ready and when it stops.
 *
 *   online    → sent on the `connection.update` "open" event, i.e. WhatsApp is
 *               actually reachable (not merely that the process booted).
 *   shutdown  → sent right before the process exits (SIGINT/SIGTERM, the
 *               control console, and a restart).
 *
 * The panel is the SAME management panel the moderation log uses, so the owner
 * has one place to watch. Nothing is sent when no panel has been configured —
 * an unconfigured deployment stays completely silent, exactly like the log
 * itself does.
 *
 * Delivery is best-effort and time-boxed: an offline peer must never delay or
 * block a shutdown, so every send races a short timeout.
 */
import config from "../config.js";
import { getSocket } from "../core/connection.js";
import { getDefaultLogPanel, getConfiguredTimezone } from "./settings.js";
import { logger } from "./logger.js";

/** How long a lifecycle notice may hold up the caller (ms). */
const SEND_TIMEOUT = 8000;

/** Panels currently receiving a lifecycle notice (avoids double sends). */
const inFlight = new Set();

/**
 * The management panel notices are posted to, or `null` when none is set.
 *
 * Only the global default panel is used (`.log default`); per-group
 * `logPanel` overrides address moderation traffic, not bot lifecycle.
 *
 * @returns {string|null}
 */
export function getManagementPanel() {
  try {
    return getDefaultLogPanel();
  } catch {
    return null;
  }
}

/** HH:MM in the configured timezone (falls back to local time). */
function clockNow() {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: getConfiguredTimezone(),
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date());
  } catch {
    return new Date().toTimeString().slice(0, 5);
  }
}

/** Human-readable uptime, e.g. "2j 14m" / "45d". */
function uptimeLabel(ms = 0) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

/**
 * Build the notice text.
 *
 * @param {"online"|"shutdown"} kind
 * @param {object} [info]
 * @param {number} [info.uptimeMs]      session uptime (shutdown only)
 * @param {string} [info.reason]        why the bot stopped (shutdown only)
 * @param {boolean} [info.restart]      a restart, not a permanent stop
 */
export function buildLifecycleNotice(kind, info = {}) {
  const name = config.bot?.name || "GX-ID";
  const version = config.bot?.version || "1.0.0";
  const lines = [];

  if (kind === "online") {
    lines.push("╭━━━「 🟢 BOT AKTIF 」━━━╮");
    lines.push("┃");
    lines.push(`┃ Bot     : ${name}`);
    lines.push(`┃ Status  : 🟢 Online`);
    lines.push(`┃ Versi   : ${version}`);
    lines.push(`┃ Waktu   : ${clockNow()}`);
    lines.push("┃");
    lines.push("┃ Bot siap menerima pesan.");
    lines.push("╰━━━━━━━━━━━━━━━━━━━━━━╯");
    return lines.join("\n");
  }

  lines.push("╭━━━「 🔴 BOT SHUTTING DOWN 」━━━╮");
  lines.push("┃");
  lines.push(`┃ Bot     : ${name}`);
  lines.push(`┃ Status  : 🔴 Offline`);
  if (info.reason) lines.push(`┃ Alasan  : ${info.reason}`);
  if (info.uptimeMs !== undefined) lines.push(`┃ Uptime  : ${uptimeLabel(info.uptimeMs)}`);
  lines.push(`┃ Waktu   : ${clockNow()}`);
  lines.push("┃");
  lines.push(info.restart ? "┃ Bot akan segera menyala kembali." : "┃ Bot berhenti.");
  lines.push("╰━━━━━━━━━━━━━━━━━━━━━━╯");
  return lines.join("\n");
}

/**
 * Send a lifecycle notice to the management panel.
 *
 * Best-effort: resolves `false` (never throws) when there is no panel, no
 * socket, or delivery fails. A timeout keeps a slow/unreachable peer from
 * delaying a shutdown.
 *
 * @param {"online"|"shutdown"} kind
 * @param {object} [info]   see `buildLifecycleNotice`
 * @param {object} [sock]   socket override (defaults to the live one)
 * @returns {Promise<boolean>} whether the notice was delivered
 */
export async function notifyLifecycle(kind, info = {}, sock = null) {
  const panel = getManagementPanel();
  if (!panel) return false;

  const target = sock || getSocket();
  if (!target?.sendMessage) return false;

  // A restart can fire online + shutdown in quick succession; never let one
  // panel get two copies of the same lifecycle event at once.
  if (inFlight.has(panel)) return false;
  inFlight.add(panel);

  try {
    const text = buildLifecycleNotice(kind, info);
    await Promise.race([
      target.sendMessage(panel, { text }),
      new Promise((resolve) => setTimeout(resolve, SEND_TIMEOUT).unref?.()),
    ]);
    logger.system(`lifecycle notice (${kind}) → management panel`);
    return true;
  } catch (error) {
    logger.warn(`lifecycle notice (${kind}) failed: ${error?.message || error}`);
    return false;
  } finally {
    inFlight.delete(panel);
  }
}

/** Announce that the bot is online. */
export function notifyOnline(sock = null) {
  return notifyLifecycle("online", {}, sock);
}

/**
 * Announce that the bot is stopping.
 *
 * @param {object} [options]
 * @param {string} [options.reason]   why (signal name, "restart", …)
 * @param {boolean} [options.restart] the bot will come back
 * @param {number} [options.uptimeMs]
 * @param {object} [sock]             socket override (defaults to the live one)
 */
export function notifyShutdown(options = {}, sock = null) {
  return notifyLifecycle(
    "shutdown",
    {
      reason: options.reason,
      restart: options.restart === true,
      uptimeMs: options.uptimeMs,
    },
    sock,
  );
}
