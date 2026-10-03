/**
 * GX-ID — console message bus
 *
 * A tiny decoupled channel between the message pipeline and the interactive
 * console. The pipeline PUBLISHES every incoming message here; the post-boot
 * console SUBSCRIBES so that, once a group or private chat is selected, the
 * conversation for that chat is printed to the terminal.
 *
 * Keeping this in its own module means `core/message.js` never has to import
 * the console (or readline), and headless deployments pay nothing: with no
 * subscribers `publishIncoming()` is a no-op.
 */
import { EventEmitter } from "events";

export const messageBus = new EventEmitter();
// A console session may attach a couple of listeners (chat view + logger).
messageBus.setMaxListeners(50);

/**
 * Broadcast an incoming message to any console subscriber.
 *
 * @param {object} info
 * @param {string} info.chat      chat JID (group `@g.us` or private `@s.whatsapp.net`)
 * @param {string} info.sender    sender JID
 * @param {string} [info.pushName] display name
 * @param {string} [info.body]     message text/caption
 * @param {string} [info.type]     serialized message type
 * @param {boolean} [info.isGroup]
 * @param {boolean} [info.fromMe]
 * @param {string} [info.id]      message id
 */
export function publishIncoming(info) {
  if (messageBus.listenerCount("incoming") === 0) return;
  try {
    messageBus.emit("incoming", info);
  } catch {
    /* a broken console subscriber must never break the pipeline */
  }
}

/** Subscribe to incoming messages. Returns an unsubscribe function. */
export function onIncoming(listener) {
  messageBus.on("incoming", listener);
  return () => messageBus.off("incoming", listener);
}
