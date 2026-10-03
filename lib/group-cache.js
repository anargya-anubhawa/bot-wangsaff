/**
 * GX-ID — group metadata cache
 *
 * Caches `groupMetadata` results for a short TTL so moderation, permission
 * checks and multi-step commands don't each hit the socket for the same group
 * within one burst. Invalidated on participant/group updates.
 */
import NodeCache from "node-cache";

const cache = new NodeCache({ stdTTL: 120, useClones: false });

/**
 * `sock.groupMetadata()` is a network round-trip. If WhatsApp is slow (or the
 * socket is half-dead) it can hang forever, which would stall the whole message
 * pipeline. Bound every lookup so a stuck request degrades instead of freezing.
 */
function withTimeout(promise, ms = 8000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error("groupMetadata timed out")), ms);
      if (timer.unref) timer.unref();
    }),
  ]);
}

export async function getGroupMetadataCached(sock, jid) {
  if (!jid) return null;
  const cached = cache.get(jid);
  if (cached) return cached;
  try {
    const metadata = await withTimeout(sock.groupMetadata(jid));
    if (metadata) cache.set(jid, metadata);
    return metadata;
  } catch {
    return null;
  }
}

export function invalidateGroupMetadata(jid) {
  if (jid) cache.del(jid);
}

export function clearGroupMetadataCache() {
  cache.flushAll();
}

/**
 * True when `number` is an admin in `jid`, using the cache. Falls back to a
 * fresh fetch when the cache is cold.
 */
export async function isParticipantAdminCached(sock, jid, number) {
  const target = String(number || "").replace(/[^0-9]/g, "");
  if (!target) return false;
  const metadata = await getGroupMetadataCached(sock, jid);
  if (!metadata) return false;
  return (metadata.participants || []).some((p) => {
    if (!p.admin) return false;
    return [p.jid, p.id, p.lid, p.phoneNumber]
      .filter(Boolean)
      .some((c) => String(c).replace(/[^0-9]/g, "") === target);
  });
}

/** True when the bot itself is an admin in `jid`, using the cache. */
export async function isBotAdminCached(sock, jid) {
  const botNumber = String(sock.user?.id || "").split(":")[0].replace(/[^0-9]/g, "");
  if (!botNumber) return false;
  const metadata = await getGroupMetadataCached(sock, jid);
  if (!metadata) return false;
  return (metadata.participants || []).some((p) => {
    if (!p.admin) return false;
    return [p.jid, p.id, p.lid, p.phoneNumber]
      .filter(Boolean)
      .some((c) => String(c).replace(/[^0-9]/g, "") === botNumber);
  });
}
