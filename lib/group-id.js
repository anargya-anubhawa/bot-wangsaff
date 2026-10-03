/**
 * GX-ID — copyable group-id rendering
 *
 * A group id (`120363001@g.us`) is long and easy to mistype, so whenever a
 * command prints one it is rendered as inline code the user can tap to copy.
 * There is deliberately no contact-card (vCard) side-channel: ids are always
 * shown as plain inline code inside the message itself.
 */

/** The bare internal id used in listings (e.g. `120363001`). */
export function internalId(jid) {
  return String(jid || "").split("@")[0];
}

/** Inline code: `` `120363001@g.us` `` — tap to copy on mobile. */
export function idInline(jid) {
  return `\`${jid}\``;
}

/** Backwards-compatible alias — ids are rendered as inline code, not a block. */
export function idCodeBlock(jid) {
  return idInline(jid);
}

/**
 * Build a ready-to-send line that shows a group's id as inline code.
 * Callers append this to their own message.
 */
export function groupIdBlock(jid, label = "ID Grup") {
  return `${label}: ${idInline(jid)}`;
}
