/**
 * GX-ID — category registry (menu / allmenu customization)
 *
 * Single source of truth for how command categories are presented by `.menu`
 * and `.allmenu`. Edit this file to customize:
 *
 *   • the emoji shown for each category
 *   • the display label (what the user sees instead of the raw key)
 *   • the sort order (lower number = earlier in the list)
 *   • visibility (hide a category entirely, or show it to the owner only)
 *
 * Categories themselves are auto-discovered from the loaded plugins, so you do
 * NOT need to declare them here — anything missing from `CATEGORIES` simply
 * falls back to `DEFAULT_EMOJI` and is sorted alphabetically at the end.
 *
 * Adding a brand-new category is therefore automatic: drop a plugin under
 * `plugins/<category>/`, and (optionally) add an entry below for a nicer emoji.
 *
 * NOTE: this file exports no `config`/`handler`, so the plugin loader ignores it
 * — it is a plain config module imported by `menu.js` and `allmenu.js`.
 */

/** Emoji used for any category that has no explicit entry in `CATEGORIES`. */
export const DEFAULT_EMOJI = "";

/** Sort weight for categories that have no explicit `order` in `CATEGORIES`. */
export const DEFAULT_ORDER = 999;

/**
 * Per-category presentation settings.
 *
 * @typedef {Object} CategoryMeta
 * @property {string}  [emoji]     Icon shown next to the category name.
 * @property {string}  [label]     Display name (defaults to the category key).
 * @property {number}  [order]     Sort weight — lower numbers come first.
 * @property {boolean} [enabled]   Set `false` to hide the category entirely.
 * @property {boolean} [ownerOnly] Only visible to the bot owner.
 */
export const CATEGORIES = {
  main: { emoji: "", label: "Main", order: 20 },
  altheora: { emoji: "💠", label: "Altheora", order: 30 },
  notes: { emoji: "📝", label: "Notes", order: 40 },
  sticker: { emoji: "🖼️", label: "Sticker", order: 50 },
  media: { emoji: "🖼️", label: "Media", order: 60 },
  game: { emoji: "🎮", label: "Game", order: 70 },
  entertainment: { emoji: "🎮", label: "Entertainment", order: 80 },
  utility: { emoji: "🧰", label: "Utility", order: 90 },
  tools: { emoji: "🧰", label: "Tools", order: 100 },
  download: { emoji: "📥", label: "Download", order: 110 },
  search: { emoji: "🔍", label: "Search", order: 120 },
  info: { emoji: "ℹ️", label: "Info", order: 130 },
  user: { emoji: "ℹ️", label: "User", order: 140 },

  owner: { emoji: "👑", label: "Owner", order: 300, ownerOnly: true },
  "bot-config": { emoji: "⚙️", label: "Bot Config", order: 310, ownerOnly: true },
  group: { emoji: "⚙️", label: "Group", order: 320, ownerOnly: true },
  "group-setup": { emoji: "⚙️", label: "Group Setup", order: 330, ownerOnly: true },
  federation: { emoji: "🛡️", label: "Federation", order: 340, ownerOnly: true },
  security: { emoji: "🛡️", label: "Security", order: 350, ownerOnly: true },
  filter: { emoji: "🧹", label: "Filter", order: 360, ownerOnly: true },
  schedule: { emoji: "⏰", label: "Schedule", order: 370, ownerOnly: true },

  // Legacy aliases kept so older plugins keep a nice icon.
  fun: { emoji: "🎮", label: "Fun", order: 131 },
  rpg: { emoji: "🎮", label: "RPG", order: 132 },
};

/** Look up the raw meta object for a category (never undefined). */
export function categoryMeta(category) {
  const key = String(category || "").toLowerCase();
  return CATEGORIES[key] || {};
}

/** Emoji for a category, falling back to `DEFAULT_EMOJI`. */
export function categoryEmoji(category) {
  return categoryMeta(category).emoji || DEFAULT_EMOJI;
}

/** Display label for a category (falls back to the raw key). */
export function categoryLabel(category) {
  const meta = categoryMeta(category);
  return meta.label || String(category || "");
}

/** Sort weight for a category, falling back to `DEFAULT_ORDER`. */
export function categoryOrder(category) {
  const order = categoryMeta(category).order;
  return typeof order === "number" ? order : DEFAULT_ORDER;
}

/**
 * Whether a category should be shown to the given viewer.
 *
 * @param {string} category
 * @param {{ isOwner?: boolean }} [viewer]
 * @returns {boolean}
 */
export function isCategoryVisible(category, viewer = {}) {
  const meta = categoryMeta(category);
  if (meta.enabled === false) return false;
  if (meta.ownerOnly && !viewer.isOwner) return false;
  return true;
}

/**
 * Filter + sort a list of categories for display.
 *
 * @param {Iterable<string>} categories
 * @param {{ isOwner?: boolean }} [viewer]
 * @returns {string[]} visible categories, in presentation order
 */
export function visibleCategories(categories, viewer = {}) {
  return [...categories]
    .filter((cat) => isCategoryVisible(cat, viewer))
    .sort((a, b) => {
      const diff = categoryOrder(a) - categoryOrder(b);
      return diff !== 0 ? diff : String(a).localeCompare(String(b));
    });
}

export default { CATEGORIES, DEFAULT_EMOJI, DEFAULT_ORDER, categoryMeta, categoryEmoji, categoryLabel, categoryOrder, isCategoryVisible, visibleCategories };
