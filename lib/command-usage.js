/**
 * VEA — automatic command usage cards
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
import { categoryTitle, pluginPermission, helpIcon, normalizeParameters, buildCommandHelp } from "./help.js";
import { permissionLabel } from "./access.js";

export { normalizeParameters };

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

/**
 * Render the usage + available-parameters card for a command.
 *
 * Like the help detail card, this is plain documentation: no decorative emoji.
 *
 * @param {object} cfg plugin config
 * @param {string} [prefix]
 * @param {{ icons?: boolean }} [options] `icons: true` restores category emoji
 */
export function renderCommandUsage(cfg, prefix = ".", options = {}) {
  /* Use the exact same layout as `.help <command>` so every auto fallback card
     looks identical to the help detail card. */
  const name = Array.isArray(cfg?.name) ? cfg.name[0] : cfg?.name;
  const detail = buildCommandHelp(name, prefix, { icons: options.icons === true });
  if (detail) return detail;

  /* plugin not in the registry (should not happen) — minimal boxed fallback */
  const icon = helpIcon(cfg?.category, options.icons === true);
  const title = icon ? `${icon} \`${cfg?.name}\`` : `\`${cfg?.name}\``;
  const lines = [];
  lines.push(`╭─〔 ${title} 〕`);
  if (cfg?.description) lines.push(`┃ Deskripsi: ${cfg.description}`);
  lines.push(`┃ Kategori: ${categoryTitle(cfg?.category)}`);
  lines.push(`┃ Permission: ${permissionLabel(pluginPermission({ config: cfg }))}`);
  if (cfg?.usage) lines.push(`┃ Usage: \`${String(cfg.usage).replace(/^\./, prefix)}\``);
  lines.push(`╰─⬣`);
  return lines.join("\n");
}
