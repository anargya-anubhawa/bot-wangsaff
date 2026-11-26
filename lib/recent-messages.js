/**
 * GX-ID — recent-message cache
 *
 * A bounded, in-memory store of the last messages seen per chat. It exists so a
 * *revoke* (a user deleting their own message) can be reported to the log panel
 * with the original content — and, when the message was media, the media itself
 * can be forwarded.
 *
 * There is NO time-based expiry: an entry lives until it is evicted by the
 * per-chat count cap (100 messages). Memory stays bounded by that count, by a
 * per-chat media count and by a hard per-file media size cap. Nothing is
 * persisted to disk.
 */
const MAX_PER_CHAT = 100;
const MAX_MEDIA_PER_CHAT = 100;
const MAX_MEDIA_BYTES = 100 * 1024 * 1024; // 100 MB
const MAX_TOTAL_MESSAGES = 5000; // global cap across all chats
const MAX_TOTAL_MEDIA_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB global media cap

/** chatJid → Map<messageId, { body, sender, type, at, media? }> */
const store = new Map();

/** Running totals, kept in sync on every insert / eviction. */
const totals = { messages: 0, media: 0, mediaBytes: 0 };

function dropEntry(chat, id) {
  const entry = chat.get(id);
  if (!entry) return;
  if (entry.media) {
    totals.media--;
    totals.mediaBytes -= entry.media.buffer?.length || 0;
  }
  totals.messages--;
  chat.delete(id);
}

function dropOldestMessage() {
  for (const [jid, chat] of store) {
    const first = chat.keys().next();
    if (first.done) {
      store.delete(jid);
      continue;
    }
    dropEntry(chat, first.value);
    return;
  }
}

function dropOldestMedia() {
  for (const chat of store.values()) {
    for (const el of chat.values()) {
      if (el.media) {
        totals.media--;
        totals.mediaBytes -= el.media.buffer?.length || 0;
        delete el.media;
        return;
      }
    }
  }
}

/** Drop the oldest cached media once a chat exceeds the media cap. */
function enforceMediaCap(chat) {
  let media = 0;
  for (const entry of chat.values()) if (entry.media) media++;
  if (media <= MAX_MEDIA_PER_CHAT) return;
  for (const entry of chat.values()) {
    if (media <= MAX_MEDIA_PER_CHAT) break;
    if (entry.media) {
      totals.media--;
      totals.mediaBytes -= entry.media.buffer?.length || 0;
      delete entry.media;
      media--;
    }
  }
}

/**
 * Remember a message for later revoke reporting.
 *
 * @param {object} m              serialized message (`{ chat, id, body, sender, type }`)
 * @param {object} [opts]
 * @param {boolean} [opts.cacheMedia]  download + keep the media buffer (bounded)
 * @param {string}  [opts.mediaType]   image|video|audio|sticker|document
 * @param {string}  [opts.mimetype]
 * @param {string}  [opts.fileName]
 */
export async function rememberMessage(m, opts = {}) {
  if (!m?.chat || !m?.id) return;
  let chat = store.get(m.chat);
  if (!chat) {
    chat = new Map();
    store.set(m.chat, chat);
  }
  const entry = {
    body: String(m.body || "").slice(0, 1000),
    sender: m.sender || null,
    type: m.type || null,
    at: Date.now(),
  };
  /* an edit/duplicate of the same id must not double-count */
  if (chat.has(m.id)) dropEntry(chat, m.id);
  chat.set(m.id, entry);
  totals.messages++;

  while (chat.size > MAX_PER_CHAT) dropEntry(chat, chat.keys().next().value);
  while (totals.messages > MAX_TOTAL_MESSAGES) dropOldestMessage();

  /* Optionally keep the media so a later revoke can forward it. Best-effort:
     failures simply leave a text-only entry. Skip the download entirely when
     the message already reports a size above the cap. */
  const declaredSize = Number(opts.fileLength) || 0;
  if (opts.cacheMedia && opts.mediaType && typeof m.download === "function" && declaredSize <= MAX_MEDIA_BYTES) {
    try {
      const buffer = await m.download();
      if (buffer && buffer.length <= MAX_MEDIA_BYTES) {
        while (totals.mediaBytes + buffer.length > MAX_TOTAL_MEDIA_BYTES && totals.media > 0) {
          dropOldestMedia();
        }
        entry.media = {
          buffer,
          mediaType: opts.mediaType,
          mimetype: opts.mimetype || "",
          fileName: opts.fileName || "",
        };
        totals.media++;
        totals.mediaBytes += buffer.length;
        enforceMediaCap(chat);
      }
    } catch {
      /* media not cached — text-only entry remains */
    }
  }
}

/** The remembered message, or null when absent. */
export function recallMessage(chatJid, messageId) {
  const chat = store.get(chatJid);
  if (!chat || !messageId) return null;
  return chat.get(messageId) || null;
}

/** chatJid → array of revoked entries (newest last), bounded. */
const deletedLog = new Map();
const MAX_DELETED_PER_CHAT = 20;

/** Remember a deleted message per chat so `.getdeleted` can recover it. */
export function markDeleted(chatJid, entry, messageId = null) {
  if (!chatJid || !entry) return;
  let list = deletedLog.get(chatJid);
  if (!list) {
    list = [];
    deletedLog.set(chatJid, list);
  }
  list.push({ ...entry, messageId: entry.messageId || messageId || null });
  while (list.length > MAX_DELETED_PER_CHAT) list.shift();
}

/** The most recently deleted message in a chat, or null. */
export function getLastDeleted(chatJid) {
  const list = deletedLog.get(chatJid);
  return list && list.length ? list[list.length - 1] : null;
}

/**
 * Pick the deleted message that best matches a quoted message: the exact
 * stanza id first, then the sender, then the latest deletion overall.
 *
 * @param {string} chatJid
 * @param {{id?:string, sender?:string}} [quoted]
 */
export function getDeletedFor(chatJid, quoted = null) {
  const list = deletedLog.get(chatJid);
  if (!list || !list.length) return null;
  if (quoted?.id) {
    const hit = [...list].reverse().find((e) => e.messageId === quoted.id);
    if (hit) return hit;
  }
  if (quoted?.sender) {
    const hit = [...list].reverse().find((e) => e.sender === quoted.sender);
    if (hit) return hit;
  }
  return list[list.length - 1];
}

/** Snapshot of the cache size + limits: chats, messages, media and bytes. */
export function recentMessagesStats() {
  return {
    chats: store.size,
    messages: totals.messages,
    media: totals.media,
    mediaBytes: totals.mediaBytes,
    limits: {
      maxPerChat: MAX_PER_CHAT,
      maxMediaPerChat: MAX_MEDIA_PER_CHAT,
      maxMediaBytes: MAX_MEDIA_BYTES,
      maxTotalMessages: MAX_TOTAL_MESSAGES,
      maxTotalMediaBytes: MAX_TOTAL_MEDIA_BYTES,
    },
  };
}

/** Drop a chat's cache (e.g. on leave). */
export function forgetChat(chatJid) {
  store.delete(chatJid);
  deletedLog.delete(chatJid);
}
