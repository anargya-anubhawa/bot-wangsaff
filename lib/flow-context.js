/**
 * GX-ID — flow context (short-lived, per chat)
 *
 * A Native Flow list is rendered in one message and answered by a *separate*
 * tap message that carries only the row id — no command arguments. When a list
 * was produced for a REMOTE target (e.g. `.blacklists kelas-a`), the tap has no
 * way to re-derive that target from the tap itself.
 *
 * This tiny TTL store bridges the gap: the command records the target it used,
 * and the flow's `build`/`onSelect` read it back. Keyed by namespace + chat +
 * user so two people in the same chat never collide.
 */
const TTL_MS = 5 * 60 * 1000;

/** key → { data, expiresAt } */
const store = new Map();

function key(namespace, chat, user) {
  return `${namespace}|${chat}|${user || ""}`;
}

export function setFlowContext(namespace, chat, user, data) {
  store.set(key(namespace, chat, user), { data, expiresAt: Date.now() + TTL_MS });
}

export function getFlowContext(namespace, chat, user) {
  const entry = store.get(key(namespace, chat, user));
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    store.delete(key(namespace, chat, user));
    return null;
  }
  return entry.data;
}

export function clearFlowContext(namespace, chat, user) {
  store.delete(key(namespace, chat, user));
}

setInterval(() => {
  const now = Date.now();
  for (const [k, entry] of store) if (entry.expiresAt <= now) store.delete(k);
}, 60_000).unref?.();
