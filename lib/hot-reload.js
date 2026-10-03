/**
 * GX-ID — hot reload watcher
 *
 * Watches the files that shape the bot at runtime and applies their changes
 * automatically, so the operator never has to stop and restart by hand:
 *
 *   • plugins/**            → SOFT reload. Every plugin module is re-imported
 *                             (cache-busted) and re-registered in place — the
 *                             WhatsApp connection, database and scheduler are
 *                             left untouched, so there is no downtime.
 *   • config.js / GX.js     → FULL restart. These modules are evaluated once at
 *   • .env                    import time, so the only way to apply them is a
 *                             fresh process (see `lib/restart.js`).
 *
 * Behaviour is tunable through the environment:
 *
 *   HOT_RELOAD=0                disable the watcher entirely
 *   HOT_RELOAD_RESTART=0        watch plugins only (ignore config/.env changes)
 *   HOT_RELOAD_DEBOUNCE=800     quiet period (ms) before a change is applied
 *
 * The watcher is intentionally best-effort: a filesystem that cannot be watched
 * (some containers, network drives) simply logs a warning and the bot keeps
 * running normally.
 */
import fs from "fs";
import path from "path";
import { logger } from "./logger.js";

const DEFAULTS = {
  debounceMs: 800,
  /** Files whose change requires a full restart (evaluated at import time). */
  restartFiles: ["config.js", "GX.js", ".env"],
};

function envFlag(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return !["0", "false", "no", "off"].includes(String(value).toLowerCase());
}

/**
 * Recursively collect every directory under `root` (including `root` itself).
 * Used to fall back to per-directory watches when recursive watching is not
 * supported by the platform.
 */
function collectDirs(root) {
  const dirs = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let stat;
    try {
      stat = fs.statSync(current);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    dirs.push(current);
    let entries = [];
    try {
      entries = fs.readdirSync(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry === "node_modules" || entry === ".git") continue;
      stack.push(path.join(current, entry));
    }
  }
  return dirs;
}

/**
 * Start watching for hot-reloadable changes.
 *
 * @param {object} options
 * @param {string} [options.root]        project root (default `process.cwd()`).
 * @param {string} [options.pluginsDir]  plugins directory (default `<root>/plugins`).
 * @param {(info: {changed: string}) => Promise<void>|void} [options.onReloadPlugins]
 *   Called to perform the soft plugin reload. The watcher does not import the
 *   plugin loader itself, so the caller stays in control of the reload.
 * @param {(info: {changed: string}) => Promise<void>|void} [options.onRestart]
 *   Called when a config/`.env` change requires a full restart.
 * @returns {{ stop: () => void, enabled: boolean }}
 */
export function startHotReload(options = {}) {
  const root = options.root || process.cwd();
  const pluginsDir = options.pluginsDir || path.join(root, "plugins");
  const debounceMs = Number(process.env.HOT_RELOAD_DEBOUNCE) || DEFAULTS.debounceMs;
  const watchPlugins = envFlag("HOT_RELOAD", true);
  const watchConfig = envFlag("HOT_RELOAD_RESTART", true);

  const enabled = watchPlugins || watchConfig;
  if (!enabled) {
    logger.system("hot reload disabled (HOT_RELOAD=0)");
    return { stop() {}, enabled: false };
  }

  /** @type {fs.FSWatcher[]} */
  const watchers = [];
  /** @type {Map<string, NodeJS.Timeout>} */
  const pending = new Map();
  let stopped = false;

  /** Collapse a burst of filesystem events into a single debounced action. */
  function schedule(key, action) {
    if (stopped) return;
    if (pending.has(key)) clearTimeout(pending.get(key));
    pending.set(
      key,
      setTimeout(async () => {
        pending.delete(key);
        if (stopped) return;
        try {
          await action();
        } catch (error) {
          logger.error(`hot reload failed: ${error?.message || error}`);
        }
      }, debounceMs),
    );
    if (pending.get(key).unref) pending.get(key).unref();
  }

  /** Watch a directory, transparently falling back to per-subdir watches. */
  function watchDir(dir, onEvent) {
    try {
      const watcher = fs.watch(dir, { recursive: true }, (eventType, filename) => {
        onEvent(eventType, filename);
      });
      watcher.on("error", (error) => logger.warn(`hot reload watch error (${dir}): ${error.message}`));
      watchers.push(watcher);
      return true;
    } catch {
      // Recursive watch unsupported (older Node / some platforms) — watch each
      // subdirectory individually. Newly created subdirectories are picked up
      // on the next reload pass.
      let ok = false;
      for (const sub of collectDirs(dir)) {
        try {
          const watcher = fs.watch(sub, (eventType, filename) => onEvent(eventType, filename));
          watcher.on("error", () => {});
          watchers.push(watcher);
          ok = true;
        } catch {
          /* skip unreadable directory */
        }
      }
      return ok;
    }
  }

  /* ── plugins → soft reload ── */
  if (watchPlugins && fs.existsSync(pluginsDir)) {
    const started = watchDir(pluginsDir, (eventType, filename) => {
      const name = String(filename || "");
      // Only `.js` plugin sources matter; ignore temp files and editor noise.
      if (name && !name.endsWith(".js")) return;
      if (name.startsWith(".") || name.endsWith("~") || name.endsWith(".swp")) return;
      schedule("plugins", async () => {
        const rel = name.replace(/\\/g, "/");
        const abs = name ? path.resolve(pluginsDir, name) : "";
        logger.system(`plugin change detected${rel ? ` (${rel})` : ""} — reloading`);
        if (options.onReloadPlugins) await options.onReloadPlugins({ changed: name, path: abs });
      });
    });
    if (started) logger.system(`hot reload active — watching plugins${watchConfig ? " + config" : ""}`);
    else logger.warn("hot reload — could not watch the plugins directory");
  }

  /* ── config / .env → full restart ── */
  if (watchConfig) {
    // Watch the project root (non-recursive) and filter for the restart files.
    // Watching the files themselves is unreliable: editors that save atomically
    // replace the file, which detaches a per-file `fs.watch` on most platforms.
    const restartSet = new Set(DEFAULTS.restartFiles);
    try {
      const watcher = fs.watch(root, { recursive: false }, (eventType, filename) => {
        const name = String(filename || "");
        if (!restartSet.has(name)) return;
        schedule(`restart:${name}`, async () => {
          logger.system(`${name} changed — restarting to apply the update`);
          if (options.onRestart) await options.onRestart({ changed: name });
        });
      });
      watcher.on("error", () => {});
      watchers.push(watcher);
    } catch {
      // Fall back to per-file watches when the root cannot be watched.
      for (const file of DEFAULTS.restartFiles) {
        const target = path.join(root, file);
        try {
          const watcher = fs.watch(target, () => {
            schedule(`restart:${file}`, async () => {
              logger.system(`${file} changed — restarting to apply the update`);
              if (options.onRestart) await options.onRestart({ changed: file });
            });
          });
          watcher.on("error", () => {});
          watchers.push(watcher);
        } catch {
          // The file may not exist (e.g. no `.env` yet) — that is fine.
        }
      }
    }
  }

  return {
    enabled: true,
    stop() {
      stopped = true;
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
      for (const watcher of watchers) {
        try {
          watcher.close();
        } catch {
          /* ignore */
        }
      }
      watchers.length = 0;
    },
  };
}
