/**
 * GX-ID — plugin loader & registry
 *
 * Discovers plugins under `plugins/<category>/<file>.js` and registers them in
 * a command/alias/category store. Two plugin shapes are supported:
 *
 *  1. Rimuru style (preferred):
 *       export const pluginConfig = { name, alias, category, ... }
 *       async function handler(m, ctx) { ... }
 *       export { pluginConfig as config, handler }
 *
 *  2. Legacy style:
 *       async function handler(m, ctx) { ... }
 *       handler.command = /^(ping)$/i
 *       handler.help = ["ping"]
 *       handler.tags = ["main"]
 *       export default handler
 */
import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { logger } from "./logger.js";

const store = {
  commands: new Map(),
  aliases: new Map(),
  categories: new Map(),
  /**
   * Absolute paths of every plugin entry file that registered successfully in
   * the last `loadPlugins()` run. Used by the hot-reload watcher to tell a
   * plugin entry (safe to soft-reload) apart from a shared helper module such
   * as `category.js` (whose edit is only picked up by a full restart, because
   * ESM resolves its importers' nested specifiers from cache).
   */
  loadedFiles: new Set(),
};

/**
 * Registry of GX-ID style "answer handlers". Game plugins export a secondary
 * function (`answerHandler`, `dungeonAnswerHandler`, `family100AnswerHandler`,
 * `kyubigameAnswerHandler`, …) that consumes free-text replies while a game is
 * running. They are collected here so the message pipeline can dispatch them.
 * Insertion order follows plugin load order; every handler self-guards.
 */
const answerHandlers = new Map();

/**
 * Registry of legacy Megami `handler.before` / `handler.all` hooks. These run
 * for every incoming message (before command dispatch) and implement the
 * answer loop for games like bom, kuis, tebakan, maths, tebakbola, …. They are
 * invoked through `runLegacyHook()` so they receive a legacy `conn` and the
 * `global.db` / `global.conn` shims they expect.
 */
const legacyHooks = new Map();

const defaultConfig = {
  name: "",
  alias: [],
  category: "uncategorized",
  description: "No description",
  usage: "",
  example: "",
  /** New centralized tier: "all" | "owner" | "admin". When unset the legacy
   *  boolean flags below are used instead. */
  permission: null,
  /** Extra example invocations rendered by `.help <command>`. */
  examples: [],
  /** Free-form notes rendered by `.help <command>`. */
  notes: "",
  isOwner: false,
  isPremium: false,
  isGroup: false,
  isPrivate: false,
  isAdmin: false,
  isBotAdmin: false,
  cooldown: 3,
  limit: 1,
  isEnabled: true,
};

/**
 * Duplicate registrations detected during the last `loadPlugins()` run. Each
 * entry is `{ kind: "command"|"alias", name, kept, dropped }`. A non-empty list
 * is warned about at startup so silent shadowing can never happen unnoticed.
 */
const conflicts = [];

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function normalizeNames(name) {
  return toArray(name)
    .map((n) => String(n || "").trim().toLowerCase())
    .filter(Boolean);
}

function normalizeAliases(alias) {
  return toArray(alias)
    .map((a) => String(a || "").trim().toLowerCase())
    .filter(Boolean);
}

/** Convert a legacy default-exported handler into a GX-ID plugin object. */
function createLegacyPlugin(fn, filePath) {
  const names = [];
  if (fn.command instanceof RegExp) {
    // `^(a|b|c)$` → ["a","b","c"]. Strip the anchors AND the grouping parens
    // so the registered names never carry the literal `(` / `)` characters.
    const src = fn.command.source
      .replace(/^\^|\$$/g, "")
      .replace(/^\(|\)$/g, "");
    src.split("|").forEach((c) => {
      const name = c.trim();
      if (name) names.push(name);
    });
  } else if (typeof fn.command === "string") {
    names.push(fn.command);
  } else if (Array.isArray(fn.command)) {
    names.push(...fn.command);
  }
  if (!names.length) names.push(path.basename(filePath, path.extname(filePath)));

  const pluginConfig = {
    ...defaultConfig,
    name: names[0],
    alias: names.slice(1),
    category: toArray(fn.tags)[0] || "uncategorized",
    description: toArray(fn.help)[0] || defaultConfig.description,
    usage: fn.usage || "",
    example: fn.example || "",
    isOwner: !!fn.owner,
    isPremium: !!fn.premium,
    isGroup: !!fn.group,
    isPrivate: !!fn.private,
    isAdmin: !!fn.admin,
    isBotAdmin: !!fn.botAdmin,
    cooldown: typeof fn.cooldown === "number" ? fn.cooldown : defaultConfig.cooldown,
    isEnabled: fn.disabled !== true,
  };

  return {
    config: pluginConfig,
    handler: async (m, ctx) => fn(m, ctx),
    legacyHooks: collectLegacyHooks(fn),
    filePath,
  };
}

/**
 * Extract every secondary answer-style handler a plugin module exports.
 * Matches `answerHandler`, `<name>AnswerHandler` (dungeon/family100/kyubigame)
 * and `nightActionHandler` (werewolf). Returns `[]` when none are present.
 */
function collectAnswerHandlers(entry) {
  const found = [];
  for (const [key, value] of Object.entries(entry || {})) {
    if (typeof value !== "function") continue;
    if (key === "handler" || key === "replyHandler") continue;
    // `nightActionHandler` (werewolf) is a command-driven action, not a
    // self-guarding answer loop — it must not run on every message.
    if (key === "answerHandler" || /AnswerHandler$/.test(key)) {
      found.push({ key, fn: value });
    }
  }
  return found;
}

/**
 * Collect the legacy Megami `handler.before` / `handler.all` answer loops from a
 * default-exported handler function. Both are self-guarding (they bail out when
 * no game session is active for the chat) and return `true` once they consume
 * the message.
 */
function collectLegacyHooks(fn) {
  const found = [];
  if (typeof fn?.before === "function") found.push({ key: "before", fn: fn.before });
  if (typeof fn?.all === "function") found.push({ key: "all", fn: fn.all });
  return found;
}

export async function loadPlugin(filePath, bustCache = false) {
  try {
    const url = pathToFileURL(path.resolve(filePath)).href + (bustCache ? `?t=${Date.now()}` : "");
    let mod = await import(url);

    if ((!mod.config || !mod.handler) && mod.default && typeof mod.default === "object" && mod.default.config) {
      mod = mod.default;
    }

    // Legacy default-exported function handler.
    if (typeof mod === "function" || (mod.default && typeof mod.default === "function" && !mod.config)) {
      const fn = typeof mod === "function" ? mod : mod.default;
      if (fn.command || fn.help || fn.tags) {
        return createLegacyPlugin(fn, filePath);
      }
      return null;
    }

    const entry = mod.config && mod.handler ? mod : mod.default;
    if (!entry || !entry.config || typeof entry.handler !== "function") return null;

    const pluginConfig = { ...defaultConfig, ...entry.config };
    if (!pluginConfig.name) {
      pluginConfig.name = path.basename(filePath, path.extname(filePath));
    }
    return {
      config: pluginConfig,
      handler: entry.handler,
      answerHandlers: collectAnswerHandlers(entry),
      filePath,
    };
  } catch (error) {
    logger.error(`failed to load ${path.basename(filePath)} — ${error.message}`);
    if (process.env.NODE_ENV === "development") console.error(error.stack);
    return null;
  }
}

export function registerPlugin(plugin) {
  if (!plugin?.config?.name) return false;
  const names = normalizeNames(plugin.config.name);
  const aliases = normalizeAliases(plugin.config.alias);
  const primary = names[0];
  if (!primary) return false;

  for (const n of names) {
    if (!store.commands.has(n) && !store.aliases.has(n)) {
      store.commands.set(n, plugin);
    } else {
      const kept = store.commands.get(n) || store.commands.get(store.aliases.get(n));
      conflicts.push({ kind: "command", name: n, kept: kept?.config?.name || n, dropped: primary });
    }
  }
  for (const a of aliases) {
    if (!store.commands.has(a) && !store.aliases.has(a)) {
      store.aliases.set(a, primary);
    } else {
      const kept = store.commands.get(a) || store.commands.get(store.aliases.get(a));
      conflicts.push({ kind: "alias", name: a, kept: kept?.config?.name || a, dropped: primary });
    }
  }

  const category = String(plugin.config.category || "uncategorized").toLowerCase();
  plugin.config.category = category;
  if (!store.categories.has(category)) store.categories.set(category, []);
  store.categories.get(category).push(plugin);

  /* collect GX-ID answer handlers for the message pipeline */
  for (const { key, fn } of plugin.answerHandlers || []) {
    answerHandlers.set(`${plugin.config.name}:${key}`, {
      name: plugin.config.name,
      key,
      fn,
    });
  }

  /* collect legacy Megami before/all answer hooks */
  for (const { key, fn } of plugin.legacyHooks || []) {
    legacyHooks.set(`${plugin.config.name}:${key}`, {
      name: plugin.config.name,
      key,
      fn,
    });
  }
  return true;
}

/**
 * (Re)load every plugin under `pluginsDir`.
 *
 * @param {string} pluginsDir
 * @param {object} [options]
 * @param {boolean} [options.bustCache] Re-import each module with a cache-busting
 *   query so a hot reload picks up on-disk edits instead of the cached ESM
 *   module. Nested imports (config, logger, …) keep their existing instances —
 *   only the plugin file itself is refreshed.
 */
export async function loadPlugins(pluginsDir, options = {}) {
  const bustCache = options.bustCache === true;

  store.commands.clear();
  store.aliases.clear();
  store.categories.clear();
  store.loadedFiles.clear();
  answerHandlers.clear();
  legacyHooks.clear();
  conflicts.length = 0;

  if (!fs.existsSync(pluginsDir)) {
    logger.warn(`plugin directory not found: ${pluginsDir}`);
    return 0;
  }

  let loaded = 0;
  const summary = [];

  const categories = fs.readdirSync(pluginsDir);
  for (const category of categories) {
    const categoryPath = path.join(pluginsDir, category);

    if (!fs.statSync(categoryPath).isDirectory()) {
      if (category.endsWith(".js") && !category.startsWith("_")) {
        const plugin = await loadPlugin(categoryPath, bustCache);
        if (plugin && registerPlugin(plugin)) {
          loaded++;
          store.loadedFiles.add(path.resolve(categoryPath));
          summary.push({ name: plugin.config.name, category: plugin.config.category });
        }
      }
      continue;
    }

    for (const file of fs.readdirSync(categoryPath)) {
      if (!file.endsWith(".js") || file.startsWith("_")) continue;
      const filePath = path.join(categoryPath, file);
      const plugin = await loadPlugin(filePath, bustCache);
      if (plugin && registerPlugin(plugin)) {
        loaded++;
        store.loadedFiles.add(path.resolve(filePath));
        summary.push({ name: plugin.config.name, category: plugin.config.category });
      }
    }
  }

  printSummary(summary);
  if (conflicts.length) {
    logger.warn(`duplicate command/alias registration detected (${conflicts.length}):`);
    for (const c of conflicts) {
      logger.warn(`  ⚠️ ${c.kind} "${c.name}" — kept "${c.kept}", ignored "${c.dropped}"`);
    }
  }
  return loaded;
}

function printSummary(plugins) {
  if (!plugins.length) return;
  const grouped = {};
  for (const p of plugins) grouped[p.category] = (grouped[p.category] || 0) + 1;
  const cats = Object.entries(grouped).sort((a, b) => b[1] - a[1]);
  const parts = cats.map(([c, n]) => `${c}:${n}`).join("  ");
  logger.plugin(`loaded ${plugins.length} plugin(s) — ${parts}`);
}

export function getPlugin(name) {
  if (!name) return null;
  const key = String(name).toLowerCase();
  if (store.commands.has(key)) return store.commands.get(key);
  if (store.aliases.has(key)) return store.commands.get(store.aliases.get(key));
  return null;
}

export function getCategories() {
  return Array.from(store.categories.keys());
}

export function getPluginCount() {
  return store.commands.size;
}

/**
 * Return the collected GX-ID answer handlers, in load order. Each entry is
 * `{ name, key, fn }`. Handlers self-guard (return `false` when the message
 * does not belong to them), so the pipeline can simply try each one.
 */
export function getAnswerHandlers() {
  return [...answerHandlers.values()];
}

/**
 * Return the collected legacy Megami `before` / `all` answer hooks, in load
 * order. Each entry is `{ name, key, fn }`.
 */
export function getLegacyHooks() {
  return [...legacyHooks.values()];
}

export function getAllCommandNames() {
  return [...store.commands.keys(), ...store.aliases.keys()];
}

export function getCommandsByCategory() {
  const result = {};
  for (const [category, plugins] of store.categories.entries()) {
    const seen = new Set();
    result[category] = [];
    for (const p of plugins) {
      if (!p?.config?.isEnabled) continue;
      for (const rawName of toArray(p.config.name)) {
        const name = String(rawName || "").trim().toLowerCase();
        if (!name || seen.has(name)) continue;
        if (store.commands.get(name) !== p) continue;
        seen.add(name);
        result[category].push(name);
      }
    }
  }
  return result;
}

export { store as pluginStore, defaultConfig, answerHandlers, legacyHooks, conflicts };

/** Duplicate registrations detected during the last `loadPlugins()` run. */
export function getConflicts() {
  return [...conflicts];
}

/**
 * Whether `filePath` was a successfully-registered plugin entry during the last
 * `loadPlugins()` run.
 *
 * The hot-reload watcher uses this to choose its strategy: an entry file can be
 * re-imported with a cache-busting query (soft reload), whereas a shared helper
 * module such as `plugins/main/category.js` is pulled in by its importers from
 * the ESM cache and can only be refreshed by a full restart.
 *
 * @param {string} filePath absolute or relative path to a file under `plugins/`.
 * @returns {boolean}
 */
export function isPluginEntryFile(filePath) {
  if (!filePath) return false;
  try {
    return store.loadedFiles.has(path.resolve(filePath));
  } catch {
    return false;
  }
}

/** Absolute paths of the plugin entry files registered in the last load. */
export function getLoadedPluginFiles() {
  return [...store.loadedFiles];
}

/**
 * Does any *other* registered plugin entry import `filePath`?
 *
 * Cross-plugin imports (`import { x } from "./werewolf.js"`) capture a binding
 * to the imported module instance. A cache-busted soft reload re-imports the
 * changed file into a NEW instance while its importers keep the OLD one, so an
 * edit to a shared plugin module would leave a stale handler behind. Detecting
 * that lets the caller fall back to a full restart instead.
 *
 * @param {string} filePath
 * @returns {boolean}
 */
export function isImportedByPlugin(filePath) {
  if (!filePath) return false;
  let target;
  try {
    target = path.resolve(filePath);
  } catch {
    return false;
  }
  for (const entry of store.loadedFiles) {
    if (entry === target) continue;
    let source;
    try {
      source = fs.readFileSync(entry, "utf8");
    } catch {
      continue;
    }
    // Match every `from "..."` / `import("...")` specifier, then resolve the
    // relative ones against the importing file's directory.
    const specifiers = [
      ...source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g),
    ].map((match) => match[1]);
    for (const spec of specifiers) {
      if (!spec.startsWith(".")) continue;
      const resolved = path.resolve(path.dirname(entry), spec);
      if (resolved === target) return true;
    }
  }
  return false;
}

/**
 * Classify how a change to a file under `plugins/` should be applied:
 *
 *   "entry"      → a standalone plugin entry: safe to soft reload in place.
 *   "restart"    → a shared helper module, or an entry imported by other
 *                  plugins: needs a full restart to apply cleanly.
 *
 * @param {string} filePath
 * @returns {"entry"|"restart"}
 */
export function classifyPluginChange(filePath) {
  if (!isPluginEntryFile(filePath)) return "restart";
  if (isImportedByPlugin(filePath)) return "restart";
  return "entry";
}
