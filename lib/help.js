/**
 * GX-ID — help metadata builder
 *
 * Builds help text straight from the live plugin registry — there is NO
 * hardcoded command list anywhere. `.help` (no args) shows categories; tapping
 * one shows its commands; tapping a command shows its detail card. The same
 * builders back `.help <command>` in plain text.
 */
import { getCategories, getCommandsByCategory, getPlugin } from "./plugins.js";
import { permissionLabel } from "./access.js";

export const CATEGORY_EMOJIS = {
  owner: "👑",
  main: "🏠",
  altheora: "💠",
  utility: "🔧",
  tools: "🛠️",
  fun: "🎮",
  game: "🎯",
  rpg: "⚔️",
  group: "👥",
  "group-setup": "⚙️",
  "bot-setting": "🔐",
  "bot-config": "🛠️",
  federation: "🤝",
  security: "🛡️",
  filter: "🧹",
  schedule: "⏰",
  notes: "📝",
  media: "🎬",
  sticker: "🖼️",
  entertainment: "🎲",
  info: "ℹ️",
  search: "🔍",
  download: "📥",
  user: "📊",
  uncategorized: "📦",
};

export function categoryEmoji(category) {
  return CATEGORY_EMOJIS[String(category || "").toLowerCase()] || "📦";
}

/** Human-friendly category name. */
export function categoryTitle(category) {
  return String(category || "uncategorized")
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** The permission tier of a plugin: explicit `permission`, else derived. */
export function pluginPermission(plugin) {
  const cfg = plugin?.config || {};
  if (cfg.permission) return cfg.permission;
  if (cfg.isOwner) return "owner";
  if (cfg.isAdmin) return "admin";
  return "all";
}

/** Every command name (primary only) grouped by category, filtered by enabled. */
export function listCategories() {
  const byCategory = getCommandsByCategory();
  const categories = getCategories().filter((c) => (byCategory[c] || []).length > 0);
  return categories.map((category) => ({
    category,
    count: (byCategory[category] || []).length,
    emoji: categoryEmoji(category),
    title: categoryTitle(category),
  }));
}

export function commandsInCategory(category) {
  const map = getCommandsByCategory();
  const list = map[String(category || "").toLowerCase()] || [];
  return list.map((name) => {
    const plugin = getPlugin(name);
    return {
      name,
      description: plugin?.config?.description || "No description",
      permission: pluginPermission(plugin),
    };
  });
}

/**
 * Build a command's detail card.
 * @param {string} name
 * @param {string} prefix
 * @returns {string|null}
 */
export function buildCommandHelp(name, prefix = ".") {
  const plugin = getPlugin(name);
  if (!plugin) return null;
  const cfg = plugin.config;
  const aliases = (Array.isArray(cfg.alias) ? cfg.alias : [cfg.alias]).filter(Boolean);
  const examples = [];
  if (Array.isArray(cfg.examples) && cfg.examples.length) examples.push(...cfg.examples);
  if (cfg.example) examples.push(cfg.example);
  if (!examples.length && cfg.usage) examples.push(cfg.usage);

  const lines = [];
  lines.push(`╭─〔 ${categoryEmoji(cfg.category)} \`${cfg.name}\` 〕`);
  lines.push(`┃ 📝 *Deskripsi:* ${cfg.description || "-"}`);
  lines.push(`┃ 🏷️ *Kategori:* ${categoryTitle(cfg.category)}`);
  lines.push(`┃ 🔐 *Permission:* ${permissionLabel(pluginPermission(plugin))}`);
  if (cfg.usage) lines.push(`┃ 📎 *Usage:* \`${cfg.usage.replace(/^\./, prefix)}\``);
  if (aliases.length) lines.push(`┃ 🔁 *Alias:* ${aliases.map((a) => `\`${prefix}${a}\``).join(", ")}`);
  if (examples.length) {
    lines.push(`┃ ✨ *Contoh:*`);
    for (const ex of [...new Set(examples)]) lines.push(`┃   › \`${String(ex).replace(/^\./, prefix)}\``);
  }
  if (cfg.notes) lines.push(`┃ 🗒️ *Catatan:* ${cfg.notes}`);
  lines.push(`╰─⬣`);
  return lines.join("\n");
}

/** Category overview body used by the flow header. */
export function buildOverviewBody(prefix = ".", pluginCount = 0, categoryCount = 0) {
  return (
    `╭─〔 📖 *BANTUAN* 〕\n` +
    `┃ Halo! Pilih kategori di bawah untuk\n` +
    `┃ melihat daftar perintahnya.\n` +
    `┃\n` +
    `┃ › ${categoryCount} kategori · ${pluginCount} perintah\n` +
    `┃ › Detail: \`${prefix}help <command>\`\n` +
    `╰─⬣`
  );
}
