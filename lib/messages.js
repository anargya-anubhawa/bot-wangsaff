/**
 * GX-ID — feedback-message switch
 *
 * The `config.messages` block holds the notices the bot sends when it *refuses*
 * or *cannot* run a command: owner-only, group-only, admin-only, cooldown,
 * ban, unregistered group, command disabled, and so on.
 *
 * A single master switch controls them all:
 *
 *   config.messages.enabled     true  → send the configured text (default)
 *                               false → suppress it and follow `onDisabled`
 *   config.messages.onDisabled  "silent" → send nothing
 *                               "react"  → react with `config.messages.react`
 *
 * Functional command output (`wait` / `success` / `error` / `genericError`) is
 * deliberately NOT routed through here — silencing a crash or a "processing"
 * notice would leave the user with no feedback at all.
 */
import config from "../config.js";

/** Whether the gate/permission feedback messages are enabled. */
export function feedbackEnabled() {
  return config.messages?.enabled !== false;
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
