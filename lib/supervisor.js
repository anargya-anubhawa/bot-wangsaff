/**
 * GX-ID — built-in supervisor
 *
 * Keeps the bot in the FOREGROUND and restarts it *in place*. This is the fix
 * for the "VPS says it didn't start, but it's actually running in the
 * background" problem: the old restart path spawned a `detached` replacement
 * and exited, which on Linux hands the prompt back while the real bot keeps
 * running unseen. Here the top-level process never leaves the terminal — it
 * stays alive as the supervisor and re-spawns the worker as its own child.
 *
 *   terminal / screen / tmux
 *     └── supervisor  (this module — stays attached, holds the instance lock)
 *           └── bot worker  (index.js with GX_SUPERVISED=1)
 *
 * The worker tells the supervisor what to do through its EXIT CODE:
 *
 *   • 75 (EX_TEMPFAIL / `RESTART_EXIT_CODE`) → relaunch immediately
 *   • 0                                       → clean stop, supervisor exits too
 *   • anything else (crash / signal)          → relaunch with exponential backoff
 *
 * The supervisor stands down automatically when something else already owns the
 * lifecycle (`node --watch`, pm2, systemd, docker, …) — see `lib/runtime-mode.js`.
 */
import { spawn } from "child_process";
import { logger } from "./logger.js";
import { RESTART_EXIT_CODE, inheritedExecArgv } from "./runtime-mode.js";

const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;
/** A worker that stayed up at least this long resets the crash backoff. */
const STABLE_AFTER_MS = 30000;

/**
 * Run the supervisor. Never returns — the process exits when the bot stops.
 *
 * @param {object} [options]
 * @param {{ setChild:(pid:number|null)=>void, release:()=>void }|null} [options.lock]
 * @param {string[]} [options.argv]  worker argv (`process.argv.slice(1)`).
 * @param {string}   [options.cwd]
 */
export function runSupervisor({ lock = null, argv = process.argv.slice(1), cwd = process.cwd() } = {}) {
  let child = null;
  let shuttingDown = false;
  let restarts = 0;
  let startedAt = 0;
  let restartTimer = null;

  /** Environment handed to the worker. */
  function workerEnv() {
    return {
      ...process.env,
      GX_SUPERVISED: "1",
      GX_SUPERVISOR_PID: String(process.pid),
      // The menu already ran in the supervisor — the worker boots straight in.
      GX_RELAUNCHED: "1",
    };
  }

  function launch({ reason = "" } = {}) {
    if (shuttingDown) return;
    startedAt = Date.now();
    logger.system(`supervisor: starting bot${reason ? ` (${reason})` : ""}`);
    child = spawn(process.execPath, [...inheritedExecArgv(), ...argv], {
      cwd,
      env: workerEnv(),
      // NOT detached: the worker stays in this process group, so it shares the
      // terminal, receives Ctrl+C, and can never be silently orphaned.
      stdio: "inherit",
    });
    child.on("exit", onExit);
    child.on("error", (error) => {
      logger.error(`supervisor: could not start the bot — ${error?.message || error}`);
      scheduleRestart("spawn error");
    });
    if (lock) {
      try {
        lock.setChild(child.pid);
      } catch {
        /* ignore */
      }
    }
  }

  function onExit(code, signal) {
    if (lock) {
      try {
        lock.setChild(null);
      } catch {
        /* ignore */
      }
    }
    const uptime = Date.now() - startedAt;

    if (shuttingDown) {
      finish(0);
      return;
    }

    // Explicit restart requested by the bot (`.restart`, hot reload, update…).
    if (code === RESTART_EXIT_CODE) {
      restarts = 0;
      logger.system("supervisor: restart requested — relaunching bot in place");
      launch({ reason: "requested restart" });
      return;
    }

    // Clean stop — the operator quit or asked to shut down.
    if (code === 0 && !signal) {
      logger.system("supervisor: bot stopped cleanly — shutting down");
      finish(0);
      return;
    }

    // Crash / unexpected signal — restart with backoff.
    if (uptime >= STABLE_AFTER_MS) restarts = 0;
    restarts += 1;
    scheduleRestart(signal ? `signal ${signal}` : `exit code ${code}`);
  }

  function scheduleRestart(reason) {
    const backoff = Math.min(MIN_BACKOFF_MS * 2 ** Math.max(0, restarts - 1), MAX_BACKOFF_MS);
    logger.warn(
      `supervisor: bot stopped (${reason}) — restarting in ${Math.round(backoff / 1000)}s (attempt ${restarts})`,
    );
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      launch({ reason: "auto restart" });
    }, backoff);
    // Intentionally NOT unref'd: this timer is the only thing keeping the
    // supervisor alive while it waits to relaunch a crashed worker.
  }

  function finish(code = 0) {
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }
    try {
      lock?.release?.();
    } catch {
      /* ignore */
    }
    process.exit(code);
  }

  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.system(`supervisor: received ${signal} — stopping the bot`);
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill(signal);
      } catch {
        /* ignore */
      }
      // Hard-kill fallback so a wedged worker can never block shutdown.
      const killer = setTimeout(() => {
        try {
          child?.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }, 8000);
      if (killer.unref) killer.unref();
    } else {
      finish(0);
    }
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  // If the supervisor ever goes away, take the worker with it — no orphans.
  process.on("exit", () => {
    try {
      child?.kill?.();
    } catch {
      /* ignore */
    }
  });

  logger.system("supervisor active — the bot runs in this terminal and restarts in place");
  launch({ reason: "initial start" });

  return {
    get child() {
      return child;
    },
  };
}
