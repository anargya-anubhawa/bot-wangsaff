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
import { restartBot, shutdownResources, isWatchMode } from "./lib/restart.js";
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

async function main() {
  const action = await runBootInterface();
  if (action === "exit") {
    logger.system("keluar dari control panel — bot tidak dijalankan");
    process.exit(0);
  }
  await boot();
  await startControlConsoleServer();
}

main().catch((error) => {
  logger.error(`boot failed: ${error?.message || error}`);
  if (process.env.NODE_ENV === "development" && error?.stack) console.error(error.stack);
  process.exit(1);
});

/* ─────────────────────────── graceful shutdown ─────────────────────────── */

async function shutdown(signal) {
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
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

export { boot };
