/**
 * GX-ID — view-once cache
 *
 * WhatsApp view-once media cannot be re-downloaded after it is opened. To let
 * `.getvo` re-send it, the message pipeline caches view-once media the moment it
 * arrives (per chat), bounded in size and count so memory stays predictable.
 */
import NodeCache from "node-cache";

const TTL_SECONDS = 60 * 60; // 1 hour
const MAX_PER_CHAT = 5;

const cache = new NodeCache({ stdTTL: TTL_SECONDS, checkperiod: 120, useClones: false });

/** Remember a view-once message's downloadable payload for `chatJid`. */
export function cacheViewOnce(chatJid, sender, mediaType, download) {
  if (!chatJid || !download) return;
  const key = `vo:${chatJid}`;
  const list = cache.get(key) || [];
  list.push({ sender, mediaType, download, at: Date.now() });
  while (list.length > MAX_PER_CHAT) list.shift();
  cache.set(key, list);
}

/** Return the most recent view-once entry for a chat (optionally by sender). */
export function getCachedViewOnce(chatJid, sender = null) {
  const list = cache.get(`vo:${chatJid}`) || [];
  if (!list.length) return null;
  if (sender) {
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].sender === sender) return list[i];
    }
  }
  return list[list.length - 1];
}

/** All cached view-once entries for a chat. */
export function listCachedViewOnce(chatJid) {
  return cache.get(`vo:${chatJid}`) || [];
}

export function clearViewOnce(chatJid) {
  cache.del(`vo:${chatJid}`);
}
