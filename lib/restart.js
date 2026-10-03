/**
 * GX-ID — process lifecycle helpers
 *
 * Centralises the "restart the bot" flow so the `.restart` owner command, the
 * hot-reload watcher and the OS signal handler all behave identically:
 *
 *   1. stop accepting new work and flush state (database, socket);
 *   2. relaunch the process.
 *
 * Relaunch strategy depends on how the bot was started:
 *
 *   • `node --watch index.js` (npm run dev)
 *       → just exit; Node's own watcher relaunches us.
 *   • pm2 / systemd / docker with a restart policy (`pm_id`, `PM2_HOME`, …)
 *       → just exit; the supervisor relaunches us.
 *   • a bare `node index.js` / `npm start` with no supervisor
 *       → spawn a detached replacement process, then exit, so the bot comes
 *         back up on its own.
 */
import { spawn } from "child_process";
import { logger } from "./logger.js";
import { getSocket } from "../core/connection.js";

/** Guard so two concurrent restart requests can never spawn two processes. */
let restarting = false;

/** True while a restart is already in flight. */
export function isRestarting() {
  return restarting;
}

/** True when Node itself (`--watch`) is responsible for relaunching the bot. */
export function isWatchMode() {
  return process.execArgv.some((arg) => arg === "--watch" || arg.startsWith("--watch="));
}

/** True when an external supervisor (pm2, …) will relaunch us on exit. */
export function isUnderSupervisor() {
  return process.env.pm_id !== undefined || Boolean(process.env.PM2_HOME);
}

/**
 * Gracefully release runtime resources without exiting the process.
 *
 * Safe to call multiple times and from any context — every step is guarded so a
 * failure to close the socket or save the database can never block the restart.
 */
export async function shutdownResources() {
  try {
    const sock = getSocket();
    if (sock) {
      try {
        await sock.sendPresenceUpdate?.("unavailable").catch(() => {});
      } catch {
        /* ignore */
      }
      sock.end?.(new Error("restarting"));
    }
  } catch {
    /* ignore */
  }

  try {
    const { getDatabase } = await import("./database.js");
    const db = getDatabase();
    if (db?.save) await db.save();
  } catch {
    /* ignore */
  }

  try {
    const { stopXmppBridge } = await import("./xmpp/manager.js");
    await stopXmppBridge();
  } catch {
    /* ignore */
  }
}

/**
 * Restart the bot.
 *
 * @param {object} [options]
 * @param {string} [options.reason]  free-form reason (logged).
 * @param {number} [options.exitCode]
 * @returns {Promise<boolean>} `false` when a restart was already in progress.
 */
export async function restartBot({ reason = "manual", exitCode = 0 } = {}) {
  if (restarting) return false;
  restarting = true;

  logger.system(`restarting bot (${reason})…`);
  await shutdownResources();

  // Node --watch and process supervisors relaunch us when we exit; spawning our
  // own child in those environments would start a duplicate bot.
  if (isWatchMode() || isUnderSupervisor()) {
    process.exit(exitCode);
  }

  try {
    // `process.argv.slice(1)` is [scriptPath, ...args] — everything after the
    // node binary — so the replacement runs exactly the same command line.
    const args = process.argv.slice(1);
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      detached: true,
      stdio: "inherit",
      env: { ...process.env, GX_RELAUNCHED: "1" },
    });
    child.unref();
  } catch (error) {
    logger.error(`restart spawn failed: ${error?.message || error} — exiting for supervisor`);
  }

  process.exit(exitCode);
}
