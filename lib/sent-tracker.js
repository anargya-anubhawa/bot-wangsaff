/**
 * GX-ID — outgoing message tracker
 *
 * Keeps a small, bounded, in-memory ring buffer of the message ids this bot has
 * sent, per chat. It exists so `.purge` can delete the bot's OWN recent messages
 * (WhatsApp only lets a client revoke messages it authored, so tracking our own
 * sends is the only reliable way to offer a "clear the bot's spam" command).
 *
 * Deliberately in-memory: the ids are only meaningful for the lifetime of the
 * session, and persisting them would leak chat identifiers to disk for no gain.
 */

const MAX_PER_CHAT = 100;

/** chatJid → Array<{ id: string, at: number }> (oldest first) */
const store = new Map();

/** Record a message the bot just sent. `key` is the Baileys send result key. */
export function recordSent(chatJid, key) {
  if (!chatJid || !key?.id) return;
  const list = store.get(chatJid) || [];
  list.push({ id: key.id, at: Date.now() });
  while (list.length > MAX_PER_CHAT) list.shift();
  store.set(chatJid, list);
}

/** Most recent `limit` sent ids for a chat, newest last. */
export function getRecentSent(chatJid, limit = 20) {
  const list = store.get(chatJid) || [];
  return list.slice(-Math.max(0, limit));
}

/** Forget the tracked ids for a chat (after a purge, or on leave). */
export function clearSent(chatJid) {
  store.delete(chatJid);
}

/** Number of tracked ids for a chat. */
export function sentCount(chatJid) {
  return (store.get(chatJid) || []).length;
}
