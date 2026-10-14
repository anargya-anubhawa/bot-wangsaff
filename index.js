/**
 * GX-ID — entry point
 *
 * Boot sequence:
 *   1. anti-crash hooks + console noise filter
 *   2. load configuration / .env
 *   3. init database
 *   4. preload assets
 *   5. load plugins
 *   6. start the WhatsApp connection
 */
import "./lib/env.js";
import fs from "fs";
import path from "path";
import config from "./config.js";
import { banner, logger } from "./lib/logger.js";
import { initDatabase } from "./lib/database.js";
import { preloadAssets } from "./lib/asset-manager.js";
import { loadPlugins, classifyPluginChange } from "./lib/plugins.js";
import { startConnection, getSocket } from "./core/connection.js";
import { messageHandler } from "./core/message.js";
import { startScheduler } from "./lib/scheduler.js";
import { runBootInterface } from "./lib/console-ui.js";
import { startControlServer } from "./lib/control-server.js";
import { startHotReload } from "./lib/hot-reload.js";
import { restartBot, shutdownResources, isWatchMode, onBeforeRestart } from "./lib/restart.js";
import { shouldSupervise, isSupervisedWorker } from "./lib/runtime-mode.js";
import { runSupervisor } from "./lib/supervisor.js";
import { acquireInstanceLock, describeHolder } from "./lib/instance-lock.js";
import { startXmppBridge, stopXmppBridge } from "./lib/xmpp/manager.js";

/* ─────────────────────────── console noise filter ─────────────────────────── */

const NOISE = [
  "Closing open session",
  "Closing session",
  "SessionEntry",
  "prekey",
  "Bad MAC",
  "Failed to decrypt",
  "Decrypted message with closed session",
];

for (const method of ["log", "warn", "error", "info"]) {
  const original = console[method].bind(console);
  console[method] = (...args) => {
    const first = args[0];
    if (typeof first === "string" && NOISE.some((n) => first.includes(n))) return;
    original(...args);
  };
}

/* ─────────────────────────── anti-crash hooks ─────────────────────────── */

process.on("uncaughtException", (error) => {
  logger.error(`uncaught exception: ${error?.message || error}`);
  if (process.env.NODE_ENV === "development" && error?.stack) console.error(error.stack);
});

process.on("unhandledRejection", (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  logger.error(`unhandled rejection: ${message}`);
  if (process.env.NODE_ENV === "development" && reason?.stack) console.error(reason.stack);
});

/* ─────────────────────────── ensure runtime dirs ─────────────────────────── */

function ensureDirs() {
  const dirs = [
    path.join(process.cwd(), "storage"),
    path.join(process.cwd(), "storage", "temp"),
    path.join(process.cwd(), "media"),
    config.database?.path || path.join(process.cwd(), "database", "main"),
  ];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

/* ─────────────────────────── hot reload ─────────────────────────── */

let hotReload = null;

/**
 * Watch `plugins/**` for edits (soft reload, no downtime) and `config.js` /
 * `GX.js` / `.env` for changes (full restart). Best-effort: a filesystem that
 * cannot be watched simply logs a warning.
 *
 * A plugin *entry* file can be re-imported in place, but a shared helper module
 * (e.g. `plugins/main/category.js`, imported by `menu.js`) is resolved by its
 * importers from the ESM cache, so editing it needs a full restart to show up.
 */
function startHotReloadWatcher() {
  if (hotReload) hotReload.stop();
  // Under `node --watch` (npm run dev) Node already restarts the process on any
  // file change, so the built-in watcher would only duplicate that work.
  if (isWatchMode()) {
    logger.system("hot reload — handled by node --watch (dev mode)");
    return;
  }
  // A restart tears the process down; make sure the watcher cannot fire a second
  // restart (or a plugin reload) while we are mid-exit.
  onBeforeRestart(() => {
    try {
      hotReload?.stop();
    } catch {
      /* ignore */
    }
    hotReload = null;
  });
  hotReload = startHotReload({
    root: process.cwd(),
    pluginsDir: path.join(process.cwd(), "plugins"),
    onReloadPlugins: async ({ changed, path: changedPath }) => {
      if (changedPath && classifyPluginChange(changedPath) === "restart") {
        logger.system(`${changed} is a shared module — restarting to apply it`);
        await restartBot({ reason: `shared plugin module changed (${changed})` });
        return;
      }
      const reloaded = await loadPlugins(path.join(process.cwd(), "plugins"), { bustCache: true });
      logger.plugin(`hot reload — ${reloaded} plugin(s) re-registered`);
    },
    onRestart: async () => {
      await restartBot({ reason: "config/.env changed" });
    },
  });
}

/* ─────────────────────────── boot ─────────────────────────── */

async function boot({ showBanner = true } = {}) {
  if (showBanner) {
    banner({
      name: config.bot?.name || "GX-ID",
      version: config.bot?.version || "1.0.0",
      mode: config.mode || "public",
      owner: config.owner?.name || "Owner",
    });
  }

  ensureDirs();

  logger.info("initializing database…");
  await initDatabase(config.database?.path || "./database/main");

  // Asset preloading is best-effort: a slow or unreachable remote asset must
  // never delay the WhatsApp connection (which made the bot look dead right
  // after boot). Kick it off in the background instead of awaiting it.
  logger.info("preloading assets…");
  preloadAssets(config.assets).catch((error) =>
    logger.warn(`asset preload: ${error?.message || error}`),
  );

  logger.info("loading plugins…");
  const count = await loadPlugins(path.join(process.cwd(), "plugins"));
  logger.plugin(`total ${count} plugin(s) registered`);

  logger.info("starting scheduler…");
  startScheduler();

  logger.info("starting connection…");
  await startConnection({
    onMessage: messageHandler,
    onGroupUpdate: async (update) => {
      try {
        const db = (await import("./lib/database.js")).getDatabase();
        const group = db.getGroup(update.id);
        if (group && update.subject) db.setGroup(update.id, { name: update.subject });
      } catch {
        /* ignore */
      }
    },
  });

  /* hot reload — apply plugin edits live, restart on config/.env changes */
  startHotReloadWatcher();

  /* XMPP bridge — best-effort; a failure here must never stop WhatsApp. */
  startXmppBridge({ getSocket }).catch((error) =>
    logger.error(`xmpp bridge: ${error?.message || error}`),
  );

  /* lightweight keep-alive so the process never idles out */
  setInterval(() => {
    if (!getSocket()) logger.warn("socket unavailable — awaiting reconnect");
  }, 5 * 60 * 1000).unref?.();
}

/* ─────────────────────────── control server ─────────────────────────── */

/** The running control server, so shutdown can close it. */
let controlServer = null;

/**
 * Start the local control server so a console client in ANOTHER terminal can
 * drive the bot. The bot keeps printing its normal logs here; the server only
 * adds a channel. It is disabled with `NO_CONSOLE=1`.
 */
async function startControlConsoleServer() {
  const disabled = ["1", "true", "yes"].includes(String(process.env.NO_CONSOLE || "").toLowerCase());
  if (disabled) return;

  controlServer = await startControlServer({
    onRestart: async () => {
      if (hotReload) hotReload.stop();
      await restartBot({ reason: "control console" });
    },
    onShutdown: async () => {
      if (hotReload) hotReload.stop();
      await controlServer?.stop();
      await shutdownResources();
      process.exit(0);
    },
  });
}

/* ─────────────────────────── instance lock ─────────────────────────── */

/**
 * The lock held by this process (when it is the lifecycle owner). `null` for a
 * supervised worker, which relies on its supervisor's lock instead.
 */
let instanceLock = null;

/**
 * True when THIS process is the built-in supervisor (not the bot worker). The
 * supervisor owns its own SIGINT/SIGTERM handling (see `lib/supervisor.js`), so
 * the worker-oriented `shutdown()` must stand down in that case to avoid exiting
 * the supervisor before it has stopped the worker (which would orphan it).
 */
let isSupervisorProcess = false;

/**
 * Take the single-instance lock so two bots can never share one session.
 *
 * @param {object} [options]
 * @param {boolean} [options.tolerate] when true, a conflict is only warned about
 *   and the caller continues WITHOUT the lock. Used under `node --watch`, where
 *   Node relaunches the process and the previous child may not have released the
 *   lock yet (a benign race) — refusing to start there would be wrong.
 * @returns {boolean} `true` when we own the lifecycle (or chose to continue).
 */
function takeInstanceLock({ tolerate = false } = {}) {
  const result = acquireInstanceLock({ label: config.bot?.name || "GX-ID" });
  if (result.ok) {
    instanceLock = result.lock;
    return true;
  }
  if (tolerate) {
    logger.warn(
      `another ${config.bot?.name || "GX-ID"} instance seems to be running (${describeHolder(result.holder)}) — continuing without the lock`,
    );
    return true;
  }
  logger.error(
    `another ${config.bot?.name || "GX-ID"} instance is already running (${describeHolder(result.holder)})`,
  );
  logger.error("stop it first, or set GX_LOCK_FILE to run an isolated copy.");
  return false;
}

/** Release the lock (idempotent). */
function releaseInstanceLock() {
  try {
    instanceLock?.release();
  } catch {
    /* ignore */
  }
  instanceLock = null;
}

// Release the lock BEFORE a restart tears the process down. This matters on the
// detached-relaunch path: the replacement child would otherwise race the parent
// for the lock file. On a supervised worker the lock is null, so this is a no-op.
onBeforeRestart(releaseInstanceLock);

async function main() {
  /* ── supervised worker: the supervisor already ran the menu + holds the lock ── */
  if (isSupervisedWorker()) {
    await boot();
    await startControlConsoleServer();
    return;
  }

  /* ── top-level: decide who owns the lifecycle ── */
  if (shouldSupervise()) {
    // Claim the lock BEFORE the menu so a second `npm start` fails fast instead
    // of making the operator pick options and only then be told it is a dupe.
    if (!takeInstanceLock()) process.exit(1);

    // The operator interacts with the menu ONCE, here in the supervisor. The
    // worker then boots straight into the bot (the supervisor sets GX_RELAUNCHED),
    // so a restart never reopens the menu.
    const action = await runBootInterface();
    if (action === "exit") {
      logger.system("keluar dari control panel — bot tidak dijalankan");
      releaseInstanceLock();
      process.exit(0);
    }

    // Never returns — the supervisor stays in the foreground and restarts the
    // worker in place (no detached/backgrounded process).
    isSupervisorProcess = true;
    runSupervisor({ lock: instanceLock });
    return;
  }

  /* ── top-level, not supervised (node --watch / pm2 / systemd / GX_SUPERVISE=0) ── */
  const watch = isWatchMode();
  if (!takeInstanceLock({ tolerate: watch })) process.exit(1);

  const action = await runBootInterface();
  if (action === "exit") {
    logger.system("keluar dari control panel — bot tidak dijalankan");
    releaseInstanceLock();
    process.exit(0);
  }
  await boot();
  await startControlConsoleServer();
}

main().catch((error) => {
  logger.error(`boot failed: ${error?.message || error}`);
  if (process.env.NODE_ENV === "development" && error?.stack) console.error(error.stack);
  releaseInstanceLock();
  process.exit(1);
});

/* ─────────────────────────── graceful shutdown ─────────────────────────── */

async function shutdown(signal) {
  if (isSupervisorProcess) return; // the supervisor handles signals itself
  logger.system(`received ${signal} — shutting down`);
  if (hotReload) hotReload.stop();
  try {
    await stopXmppBridge();
  } catch {
    /* ignore */
  }
  try {
    await controlServer?.stop();
  } catch {
    /* ignore */
  }
  await shutdownResources();
  releaseInstanceLock();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
// A clean exit (e.g. `process.exit(0)` from the control console) must always
// release the lock so the next start is never blocked by a ghost holder.
process.on("exit", releaseInstanceLock);

export { boot };
