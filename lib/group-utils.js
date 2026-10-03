/**
 * GX-ID — group helper utilities shared by group plugins.
 */
import { findParticipantByNumber } from "./lid.js";

/**
 * Resolve a target JID from a quoted message, mentions, or the first argument
 * (a phone number). Returns the raw target JID string or null.
 */
export function resolveTarget(m) {
  if (m.quoted?.sender) return m.quoted.sender;
  if (m.mentionedJid && m.mentionedJid.length) return m.mentionedJid[0];
  const arg = m.args?.[0];
  if (arg) {
    const num = arg.replace(/[^0-9]/g, "");
    if (num.length >= 8) return `${num}@s.whatsapp.net`;
  }
  return null;
}

/** Find a participant object in group metadata matching a target JID. */
export function findParticipant(participants, targetJid) {
  return findParticipantByNumber(participants, targetJid);
}

/** Number string (without @server) for a JID. */
export function numberFromJid(jid) {
  return String(jid || "").split("@")[0].split(":")[0];
}

/** Normalize a phone number to a JID, upgrading leading 0 to 62 (Indonesia). */
export function normalizeToJid(input) {
  let num = String(input || "").replace(/[^0-9]/g, "");
  if (num.startsWith("0")) num = `62${num.slice(1)}`;
  return num.length >= 8 ? `${num}@s.whatsapp.net` : null;
}

/** Check whether the bot itself is an admin in the given group metadata. */
export function botIsAdmin(groupMetadata, botJid) {
  const botNum = numberFromJid(botJid);
  return (groupMetadata?.participants || []).some((p) => {
    if (!p.admin) return false;
    const pj = p.jid || p.id || "";
    return numberFromJid(pj) === botNum;
  });
}
