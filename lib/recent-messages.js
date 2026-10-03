/**
 * GX-ID — recent-message cache (TTL)
 *
 * A small, bounded, in-memory store of the last messages seen per chat. It
 * exists so a *revoke* (a user deleting their own message) can be reported to
 * the log panel with the original content — and, when the message was media and
 * the panel is a separate chat, the media itself can be forwarded.
 *
 * Nothing is persisted and nothing is kept beyond the TTL — this is deliberately
 * NOT a message archive ("jangan menyimpan semua message secara permanen").
 * Media is only cached when the caller asks for it (i.e. the chat has an
 * external log panel) and is bounded by size and count so memory cannot grow.
 */
const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_PER_CHAT = 60;
const MAX_MEDIA_PER_CHAT = 6;
const MAX_MEDIA_BYTES = 8 * 1024 * 1024; // 8 MB

/** chatJid → Map<messageId, { body, sender, type, at, ttlMs, media? }> */
const store = new Map();

/** Drop the oldest cached media once a chat exceeds the media cap. */
function enforceMediaCap(chat) {
  let media = 0;
  for (const entry of chat.values()) if (entry.media) media++;
  if (media <= MAX_MEDIA_PER_CHAT) return;
  for (const entry of chat.values()) {
    if (media <= MAX_MEDIA_PER_CHAT) break;
    if (entry.media) {
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
 * @param {number}  [opts.ttlMs]
 */
export async function rememberMessage(m, opts = {}) {
  if (!m?.chat || !m?.id) return;
  const ttlMs = opts.ttlMs || DEFAULT_TTL_MS;
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
    ttlMs,
  };
  chat.set(m.id, entry);
  while (chat.size > MAX_PER_CHAT) chat.delete(chat.keys().next().value);

  /* Optionally keep the media so a later revoke can forward it. Best-effort:
     failures simply leave a text-only entry. */
  if (opts.cacheMedia && opts.mediaType && typeof m.download === "function") {
    try {
      const buffer = await m.download();
      if (buffer && buffer.length <= MAX_MEDIA_BYTES) {
        entry.media = {
          buffer,
          mediaType: opts.mediaType,
          mimetype: opts.mimetype || "",
          fileName: opts.fileName || "",
        };
        enforceMediaCap(chat);
      }
    } catch {
      /* media not cached — text-only entry remains */
    }
  }
}

/** The remembered message, or null when absent/expired. */
export function recallMessage(chatJid, messageId) {
  const chat = store.get(chatJid);
  if (!chat || !messageId) return null;
  const entry = chat.get(messageId);
  if (!entry) return null;
  if (Date.now() - entry.at > entry.ttlMs) {
    chat.delete(messageId);
    return null;
  }
  return entry;
}

/** Drop a chat's cache (e.g. on leave). */
export function forgetChat(chatJid) {
  store.delete(chatJid);
}

/* periodic sweep so expired entries never accumulate */
setInterval(() => {
  const now = Date.now();
  for (const [jid, chat] of store) {
    for (const [id, entry] of chat) {
      if (now - entry.at > entry.ttlMs) chat.delete(id);
    }
    if (!chat.size) store.delete(jid);
  }
}, 60_000).unref?.();
