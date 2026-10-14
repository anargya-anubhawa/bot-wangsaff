/**
 * GX-ID — process lifecycle helpers
 *
 * Centralises the "restart the bot" flow so the `.restart` owner command, the
 * hot-reload watcher and the OS signal handler all behave identically:
 *
 *   1. stop accepting new work and flush state (database, socket);
 *   2. relaunch the process.
 *
 * How the relaunch happens depends on who owns the lifecycle (see
 * `lib/runtime-mode.js`):
 *
 *   • built-in supervisor (`GX_SUPERVISED=1`)  — the DEFAULT. This process is
 *       the supervisor's child; it exits with `RESTART_EXIT_CODE` (75) and the
 *       supervisor re-spawns it IN PLACE, still attached to the terminal. This
 *       is what stops a restart from detaching into the background.
 *   • `node --watch index.js` (npm run dev)
 *       → just exit; Node's own watcher relaunches us.
 *   • pm2 / systemd / docker / k8s with a restart policy
 *       → just exit; the supervisor relaunches us.
 *   • a bare `node index.js` with the supervisor disabled (`GX_SUPERVISE=0`)
 *       → spawn a replacement and exit. Output is redirected to a log file and
 *         the location is printed, so the new process is never "invisible".
 */
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { logger } from "./logger.js";
import { getSocket } from "../core/connection.js";
import {
  RESTART_EXIT_CODE,
  isSupervisedWorker,
  isWatchMode,
  isUnderSupervisor,
  inheritedExecArgv,
} from "./runtime-mode.js";

export { isWatchMode, isUnderSupervisor, isSupervisedWorker, restartStrategyLabel } from "./runtime-mode.js";

/** Guard so two concurrent restart requests can never spawn two processes. */
let restarting = false;

/** Cleanup callbacks run once, right before the process exits to restart. */
const beforeRestartHooks = [];

/**
 * Register a synchronous cleanup to run before every restart (e.g. stop the
 * hot-reload watcher so it cannot fire a second restart mid-exit). Returns an
 * unsubscribe function.
 */
export function onBeforeRestart(fn) {
  if (typeof fn !== "function") return () => {};
  beforeRestartHooks.push(fn);
  return () => {
    const index = beforeRestartHooks.indexOf(fn);
    if (index >= 0) beforeRestartHooks.splice(index, 1);
  };
}

function runBeforeRestartHooks() {
  for (const fn of beforeRestartHooks.splice(0)) {
    try {
      fn();
    } catch {
      /* a cleanup failure must never block the restart */
    }
  }
}

/** True while a restart is already in flight. */
export function isRestarting() {
  return restarting;
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
 * Relaunch the bot as a standalone background process (only used when nothing
 * supervises us and the built-in supervisor is disabled). The child's stdout and
 * stderr are appended to `storage/logs/bot.out.log` and the path is logged, so a
 * detached bot is never invisible to the operator again.
 */
function relaunchDetached(exitCode) {
  const logDir = path.join(process.cwd(), "storage", "logs");
  let out = "ignore";
  let err = "ignore";
  try {
    fs.mkdirSync(logDir, { recursive: true });
    const fd = fs.openSync(path.join(logDir, "bot.out.log"), "a");
    out = fd;
    err = fd;
  } catch {
    /* fall back to discarding output */
  }

  try {
    // `process.argv.slice(1)` is [scriptPath, ...args] — everything after the
    // node binary — so the replacement runs exactly the same command line.
    const args = process.argv.slice(1);
    const child = spawn(process.execPath, [...inheritedExecArgv(), ...args], {
      cwd: process.cwd(),
      detached: true,
      stdio: ["ignore", out, err],
      env: { ...process.env, GX_RELAUNCHED: "1" },
    });
    child.unref();
    logger.system(
      `relaunched as pid ${child.pid} — output → ${path.join("storage", "logs", "bot.out.log")}`,
    );
  } catch (error) {
    logger.error(`restart spawn failed: ${error?.message || error} — exiting for supervisor`);
  }

  process.exit(exitCode);
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
  runBeforeRestartHooks();
  await shutdownResources();

  // Supervised worker: exit with the "restart me" code so the built-in
  // supervisor re-spawns us IN PLACE (still attached to the terminal).
  if (isSupervisedWorker()) {
    process.exit(RESTART_EXIT_CODE);
  }

  // Node --watch and external supervisors relaunch us when we exit; spawning our
  // own child in those environments would start a duplicate bot.
  if (isWatchMode() || isUnderSupervisor()) {
    process.exit(exitCode);
  }

  // Nobody is supervising us and the built-in supervisor is off — relaunch.
  relaunchDetached(exitCode);
}
