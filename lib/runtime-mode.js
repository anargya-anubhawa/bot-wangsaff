/**
 * GX-ID — runtime mode detection
 *
 * Decides *who* is responsible for relaunching the bot after it exits, so the
 * restart path never fights itself (the old "two bots at once" / "leaked to the
 * background" bugs). The possible owners, in priority order:
 *
 *   • the built-in supervisor  (this bot's own parent process — the default)
 *   • `node --watch`           (npm run dev)
 *   • an external supervisor   (pm2, systemd, kubernetes, docker restart policy)
 *   • nobody                   (a bare `node index.js` with the supervisor off)
 *
 * Every helper here is pure detection — nothing spawns or exits. The actual
 * relaunch lives in `lib/supervisor.js` and `lib/restart.js`.
 */
import fs from "fs";

/** Exit code a supervised worker uses to say "restart me". */
export const RESTART_EXIT_CODE = Number(process.env.GX_RESTART_CODE) || 75; // EX_TEMPFAIL

/** True when THIS process is the supervised bot worker (not the supervisor). */
export function isSupervisedWorker() {
  return process.env.GX_SUPERVISED === "1";
}

/** True when the process was relaunched automatically (skip the boot menu). */
export function isRelaunched() {
  return process.env.GX_RELAUNCHED === "1";
}

/** True when Node itself (`--watch`) is responsible for relaunching the bot. */
export function isWatchMode() {
  return process.execArgv.some((arg) => arg === "--watch" || arg.startsWith("--watch="));
}

/**
 * Which external supervisor (if any) owns our lifecycle?
 *
 * @returns {"pm2"|"systemd"|"kubernetes"|"docker"|null}
 */
export function detectSupervisor() {
  if (process.env.pm_id !== undefined || process.env.PM2_HOME) return "pm2";
  if (process.env.INVOCATION_ID || process.env.JOURNAL_STREAM || process.env.NOTIFY_SOCKET) {
    return "systemd";
  }
  if (process.env.KUBERNETES_SERVICE_HOST) return "kubernetes";
  if (process.env.container || process.env.DOCKER_CONTAINER) return "docker";
  try {
    if (fs.existsSync("/.dockerenv")) return "docker";
  } catch {
    /* ignore */
  }
  return null;
}

/** True when an external supervisor will relaunch us on exit. */
export function isUnderSupervisor() {
  return detectSupervisor() !== null;
}

/** Is the built-in supervisor explicitly disabled? */
function superviseDisabled() {
  const value = process.env.GX_SUPERVISE;
  if (value === undefined || value === "") return false;
  return ["0", "false", "no", "off"].includes(String(value).toLowerCase());
}

/**
 * Should THIS (top-level) process act as the bot's own supervisor?
 *
 * The built-in supervisor keeps the bot in the FOREGROUND and restarts the
 * worker in place, so a restart never detaches into the background. It is used
 * by default and stands down whenever something else already owns the
 * lifecycle (watch mode or an external supervisor), unless the operator forces
 * it with `GX_SUPERVISE=1`.
 */
export function shouldSupervise() {
  if (isSupervisedWorker()) return false;
  const forced = ["1", "true", "yes", "on"].includes(String(process.env.GX_SUPERVISE || "").toLowerCase());
  if (forced) return true;
  if (superviseDisabled()) return false;
  if (isWatchMode()) return false;
  if (isUnderSupervisor()) return false;
  return true;
}

/** Short human label for the current restart strategy (status commands/logs). */
export function restartStrategyLabel() {
  if (isSupervisedWorker()) return "supervisor bawaan (in-place)";
  if (isWatchMode()) return "node --watch (auto)";
  const supervisor = detectSupervisor();
  if (supervisor) return `supervisor eksternal (${supervisor})`;
  return "relaunch (proses baru)";
}

/**
 * Node flags to forward to a re-spawned process (e.g. `--max-old-space-size`,
 * `--enable-source-maps`). `--watch` is intentionally dropped: the relaunched
 * child must not start its own watcher (that would fight the supervisor).
 *
 * @returns {string[]}
 */
export function inheritedExecArgv() {
  return process.execArgv.filter((arg) => arg !== "--watch" && !arg.startsWith("--watch="));
}
