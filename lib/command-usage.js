/**
 * GX-ID — automatic command usage cards
 *
 * When a *parent* command is sent with no arguments (and no quoted/mentioned
 * target), the bot replies with a short usage card listing the command's
 * available parameters. This is derived entirely from live plugin metadata —
 * there is NO hardcoded command list anywhere.
 *
 * Rules (all evaluated centrally by `shouldShowUsage`):
 *   • the `game` category is always excluded;
 *   • only the command's PRIMARY name triggers the card — aliases keep their
 *     legacy behaviour, so `.filters` (alias) still lists while `.filter`
 *     (primary) shows the card;
 *   • it only fires for a bare invocation: no args, no quoted message and no
 *     mentions;
 *   • a command opts OUT with `helpOnEmpty: false` (or `runsBare: true`) — used
 *     by commands that legitimately run with no arguments (status/list/action);
 *   • a command opts IN with `helpOnEmpty: true` or an explicit `parameters`
 *     array (used by the merged, parameter-driven commands);
 *   • otherwise the heuristic is: a `usage` string containing `<...>` means the
 *     command takes parameters, so a bare call shows the card.
 */
import { categoryEmoji, categoryTitle, pluginPermission } from "./help.js";
import { permissionLabel } from "./access.js";

/** Normalise a plugin's `parameters` metadata into `{ name, description }`. */
export function normalizeParameters(cfg) {
  const out = [];
  const raw = Array.isArray(cfg?.parameters) ? cfg.parameters : [];
  for (const item of raw) {
    if (!item) continue;
    if (typeof item === "string") {
      out.push({ name: item, description: "" });
    } else if (typeof item === "object") {
      const name = item.name || item.param || item.usage || "";
      const description = item.description || item.desc || "";
      if (name) out.push({ name, description });
    }
  }
  /* Fallback: derive the parameter names from the `<...>` tokens in `usage`
     so even commands that only declare a usage string get a useful list. */
  if (!out.length && cfg?.usage) {
    const re = /<([^>]+)>/g;
    let match;
    while ((match = re.exec(String(cfg.usage)))) {
      out.push({ name: match[1], description: "" });
    }
  }
  return out.filter((p) => p.name);
}

/** Does this command declare (or imply) parameters? */
export function hasParameters(cfg) {
  if (!cfg) return false;
  if (Array.isArray(cfg.parameters) && cfg.parameters.length) return true;
  return /<[^>]+>/.test(String(cfg.usage || ""));
}

/** The primary registered name of a plugin config. */
function primaryName(cfg) {
  const raw = Array.isArray(cfg?.name) ? cfg.name[0] : cfg?.name;
  return String(raw || "").toLowerCase();
}

/**
 * Decide whether a bare invocation of `m.command` should render the usage card
 * instead of running the plugin.
 *
 * @param {object} m serialized message (uses `command`, `args`, `quoted`, `mentionedJid`)
 * @param {object} cfg plugin config
 * @returns {boolean}
 */
export function shouldShowUsage(m, cfg) {
  if (!cfg) return false;
  if (String(cfg.category || "").toLowerCase() === "game") return false;

  /* explicit opt-out — commands that legitimately run with no arguments */
  if (cfg.helpOnEmpty === false || cfg.runsBare === true) return false;

  /* only the primary name triggers the card; aliases keep legacy behaviour */
  const invoked = String(m?.command || "").toLowerCase();
  if (!invoked || invoked !== primaryName(cfg)) return false;

  /* only a bare invocation: no args, no quoted message, no mentions */
  if ((m?.args || []).length > 0) return false;
  if (m?.quoted) return false;
  if (Array.isArray(m?.mentionedJid) && m.mentionedJid.length > 0) return false;

  /* explicit opt-in */
  if (cfg.helpOnEmpty === true) return true;

  return hasParameters(cfg);
}

/** Render the usage + available-parameters card for a command. */
export function renderCommandUsage(cfg, prefix = ".") {
  const params = normalizeParameters(cfg);
  const aliases = (Array.isArray(cfg?.alias) ? cfg.alias : [cfg?.alias]).filter(Boolean);
  const examples = [];
  if (Array.isArray(cfg?.examples) && cfg.examples.length) examples.push(...cfg.examples);
  if (cfg?.example) examples.push(cfg.example);
  if (!examples.length && cfg?.usage) examples.push(cfg.usage);

  const lines = [];
  lines.push(`╭─〔 ${categoryEmoji(cfg?.category)} \`${cfg?.name}\` 〕`);
  if (cfg?.description) lines.push(`┃ 📝 ${cfg.description}`);
  lines.push(`┃ 🏷️ Kategori: ${categoryTitle(cfg?.category)}`);
  lines.push(`┃ 🔐 Permission: ${permissionLabel(pluginPermission({ config: cfg }))}`);
  if (cfg?.usage) lines.push(`┃ 📎 *Usage:* \`${String(cfg.usage).replace(/^\./, prefix)}\``);
  if (params.length) {
    lines.push(`┃`);
    lines.push(`┃ ⚙️ *Parameter tersedia:*`);
    for (const p of params) {
      lines.push(`┃   › \`${p.name}\`${p.description ? ` — ${p.description}` : ""}`);
    }
  }
  if (aliases.length) {
    lines.push(`┃ 🔁 *Alias:* ${aliases.map((a) => `\`${prefix}${a}\``).join(", ")}`);
  }
  if (examples.length) {
    lines.push(`┃ ✨ *Contoh:*`);
    for (const ex of [...new Set(examples)]) {
      lines.push(`┃   › \`${String(ex).replace(/^\./, prefix)}\``);
    }
  }
  lines.push(`╰─⬣`);
  return lines.join("\n");
}
