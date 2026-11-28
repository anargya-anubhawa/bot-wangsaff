/**
 * VEA — owner source of truth for the remote panel (manifest only)
 *
 * The Android panel reads the *same* owner list the bot enforces at runtime:
 *   config.owner.number (OWNER_NUMBER in .env) ∪ db.setting("ownerNumbers")
 *   ∪ config.bot.number (the bot itself, which config.isOwner also accepts).
 *
 * `control-ext.js` imports this when present and falls back to its own copy on
 * a plain `git pull` (module load order), so the panel never disagrees with
 * `.owner`/`isOwner` after a plugin reload. Kept dependency-free on purpose:
 * extending this list is the one thing that must match `config.isOwner`.
 */

function digits(value) {
  return String(value || "").split("@")[0].split(":")[0].replace(/[^0-9]/g, "");
}

/**
 * @param {{ config?: object, db?: object }} ctx
 * @returns {string[]} unique owner numbers as digits (own .env entries first)
 */
export function collectOwners({ config, db } = {}) {
  const numbers = new Set();
  const push = (value) => {
    const n = digits(value);
    if (n) numbers.add(n);
  };
  const configured = config?.owner?.number;
  if (Array.isArray(configured)) configured.forEach(push);
  else if (configured) push(configured);

  let extra = [];
  try {
    extra = db?.setting("ownerNumbers") || [];
  } catch {
    extra = [];
  }
  if (Array.isArray(extra)) extra.forEach(push);

  if (config?.bot?.number) push(config.bot.number);
  return [...numbers];
}
