/**
 * GX-ID — presence simulation
 *
 * Sends a short "composing…" presence before a reply and a "paused" after,
 * mirroring a human typing. Purely cosmetic; controlled by `presencesim` /
 * `presencedelay`. Failures are swallowed so a presence hiccup never breaks a
 * command.
 */
import { isPresenceSimEnabled, getPresenceDelayRange } from "./settings.js";

/** Extra typing time proportional to the message length (bounded). */
function typingBonus(text) {
  const length = String(text || "").length;
  return Math.min(2500, length * 15);
}

/**
 * Send `content` to `jid` after a simulated typing pause.
 * @returns {Promise<object|null>} the socket send result, or null when skipped.
 */
export async function sendWithPresence(sock, jid, content, options = {}) {
  if (!isPresenceSimEnabled()) {
    return sock.sendMessage(jid, content, options).catch(() => null);
  }

  const [min, max] = getPresenceDelayRange();
  const textLength = content?.text?.length || content?.caption?.length || 0;
  const delay = min + Math.random() * Math.max(0, max - min) + typingBonus(textLength);

  try {
    await sock.sendPresenceUpdate("composing", jid).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, Math.min(delay, 8000)));
  } catch {
    /* ignore */
  }

  const result = await sock.sendMessage(jid, content, options).catch(() => null);
  try {
    await sock.sendPresenceUpdate("paused", jid).catch(() => {});
  } catch {
    /* ignore */
  }
  return result;
}
