/**
 * GX-ID — feedback-message switch
 *
 * The `config.messages` block holds the notices the bot sends when it *refuses*
 * or *cannot* run a command: owner-only, group-only, admin-only, cooldown,
 * ban, unregistered group, unknown command, command disabled, and so on.
 *
 * A single master switch — "silent mode" — controls them all. It can be set
 * three ways, in order of precedence:
 *
 *   1. `.silent on|off`   → runtime override, persisted in the DB (`silentMode`)
 *   2. `config.messages.silent`  → the config default (optionally from
 *                                  `MESSAGES_SILENT` in `.env`)
 *   3. `config.messages.enabled` → legacy alias: `false` means silent
 *
 * While silent mode is ON the bot sends no notice; whether it instead reacts to
 * the triggering message is decided by `config.messages.onDisabled`:
 *
 *   config.messages.onDisabled  "silent" → send nothing (default)
 *                               "react"  → react with `config.messages.react`
 *
 * Functional command output (`wait` / `success` / `error` / `genericError`) and
 * the bare-command usage/help cards are deliberately NOT routed through here —
 * silencing a crash, a "processing" notice or an explicit help request would
 * leave the user with no feedback at all.
 */
import config from "../config.js";
import { getDatabase } from "./database.js";

/** Read a persisted global setting, tolerating an uninitialised database. */
function dbSetting(key) {
  try {
    return getDatabase().setting(key);
  } catch {
    return undefined;
  }
}

/**
 * Whether silent mode is currently ON (all gate/permission notices suppressed).
 *
 * Precedence: runtime DB override → `config.messages.silent` → legacy
 * `config.messages.enabled === false`.
 */
export function silentEnabled() {
  const override = dbSetting("silentMode");
  if (typeof override === "boolean") return override;
  if (typeof config.messages?.silent === "boolean") return config.messages.silent;
  return config.messages?.enabled === false;
}

/** Persist the silent-mode override (used by `.silent on|off`). Pass `undefined`
 *  to clear the override so the config default applies again. */
export function setSilentMode(enabled) {
  try {
    getDatabase().setting("silentMode", enabled === undefined ? null : !!enabled);
    return true;
  } catch {
    return false;
  }
}

/** Whether the gate/permission feedback messages are enabled. */
export function feedbackEnabled() {
  return !silentEnabled();
}

/** The configured fallback mode while feedback is disabled. */
export function disabledMode() {
  return String(config.messages?.onDisabled || "silent").toLowerCase() === "react" ? "react" : "silent";
}

/**
 * Deliver a gate/permission notice, honouring the master switch.
 *
 * When feedback is enabled the text is sent (no-op for an empty string).
 * When disabled, either nothing happens ("silent") or the triggering message is
 * reacted to ("react").
 *
 * @param {object} m    serialized message (needs `reply` and, for "react", `react`)
 * @param {string} text the configured notice
 * @returns {Promise<boolean>} whether anything was sent or reacted to
 */
export async function sendFeedback(m, text) {
  if (feedbackEnabled()) {
    if (!text) return false;
    await m.reply(text).catch(() => {});
    return true;
  }

  if (disabledMode() === "react" && typeof m?.react === "function") {
    await m.react(config.messages?.react || "🔒").catch(() => {});
    return true;
  }

  return false;
}

/**
 * Same switch, for call sites that talk to the socket directly instead of
 * going through `m` (e.g. the anti-call notice). There is no message to react
 * to, so "react" degrades to "silent".
 *
 * @param {object} sock    Baileys socket
 * @param {string} jid     destination
 * @param {string} text    the configured notice
 * @returns {Promise<boolean>} whether the text was sent
 */
export async function sendFeedbackTo(sock, jid, text) {
  if (!feedbackEnabled() || !text) return false;
  await sock.sendMessage(jid, { text }).catch(() => {});
  return true;
}
