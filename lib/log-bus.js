/**
 * GX-ID — log bus
 *
 * A tiny decoupled channel that mirrors every logger line to any subscriber.
 * The bot's own console keeps printing logs as usual; the interactive control
 * server subscribes so a console client on another terminal can show the same
 * feed. With no subscribers `publishLog()` is a no-op, so headless runs pay
 * nothing.
 */
import { EventEmitter } from "events";

export const logBus = new EventEmitter();
logBus.setMaxListeners(50);

/**
 * Publish one log line.
 *
 * @param {object} entry
 * @param {string} entry.tag      log tag (INFO, COMMAND, ERROR, …)
 * @param {string} entry.message  the formatted message
 */
export function publishLog(entry) {
  if (logBus.listenerCount("log") === 0) return;
  try {
    logBus.emit("log", entry);
  } catch {
    /* a broken subscriber must never break logging */
  }
}

/** Subscribe to log lines. Returns an unsubscribe function. */
export function onLog(listener) {
  logBus.on("log", listener);
  return () => logBus.off("log", listener);
}
