/**
 * GX-ID — group service
 *
 * Thin, documented wrapper around Baileys' group-management socket methods.
 * Centralising the calls here means command handlers stay small and Baileys
 * API changes only need adapting in one place.
 *
 * WhatsApp caps bulk participant operations, so `addMembers`/`removeMembers`
 * chunk to batches and pace consecutive batches through `delayBeforeNextBulkAction`.
 */
import { toNumber } from "./access.js";
import { getBulkActionDelayRange } from "./settings.js";

const PARTICIPANT_BATCH_SIZE = 20;

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function delayBeforeNextBulkAction() {
  const [min, max] = getBulkActionDelayRange();
  if (max <= 0) return;
  const delay = min + Math.random() * Math.max(0, max - min);
  await new Promise((resolve) => setTimeout(resolve, delay));
}

export async function renameGroup(sock, jid, name) {
  await sock.groupUpdateSubject(jid, name);
}

export async function setDescription(sock, jid, description) {
  await sock.groupUpdateDescription(jid, description);
}

export async function getInviteLink(sock, jid) {
  const code = await sock.groupInviteCode(jid);
  return `https://chat.whatsapp.com/${code}`;
}

export async function revokeInviteLink(sock, jid) {
  const code = await sock.groupRevokeInvite(jid);
  return `https://chat.whatsapp.com/${code}`;
}

/** Adds one or more members, returning per-number results. */
export async function addMembers(sock, jid, numberJids) {
  const results = [];
  const batches = chunk(numberJids, PARTICIPANT_BATCH_SIZE);
  for (let i = 0; i < batches.length; i++) {
    if (i > 0) await delayBeforeNextBulkAction();
    const res = await sock.groupParticipantsUpdate(jid, batches[i], "add");
    for (const r of res) results.push({ jid: r.jid || "", status: String(r.status) });
  }
  return results;
}

/** Removes one or more members, pacing consecutive batches. */
export async function removeMembers(sock, jid, numberJids) {
  const batches = chunk(numberJids, PARTICIPANT_BATCH_SIZE);
  for (let i = 0; i < batches.length; i++) {
    if (i > 0) await delayBeforeNextBulkAction();
    await sock.groupParticipantsUpdate(jid, batches[i], "remove");
  }
}

/**
 * Kick every participant who is not admin/superadmin and not the bot itself.
 * Returns the number of targets removed. LID-aware: the bot's own participant
 * id may be a `@lid`, so a naive JID compare would fail and the bot could kick
 * itself out.
 */
export async function kickAllNonAdmins(sock, jid) {
  const metadata = await sock.groupMetadata(jid);
  const botNumber = toNumber(sock.user?.id);
  const targets = [];
  for (const p of metadata.participants || []) {
    if (p.admin) continue;
    const pn = toNumber(p.phoneNumber || p.jid || p.id);
    if (botNumber && pn === botNumber) continue;
    const targetJid = p.jid || p.id;
    if (targetJid) targets.push(targetJid);
  }
  if (targets.length > 0) await removeMembers(sock, jid, targets);
  return targets.length;
}

export async function promoteToAdmin(sock, jid, numberJids) {
  await sock.groupParticipantsUpdate(jid, numberJids, "promote");
}

export async function demoteFromAdmin(sock, jid, numberJids) {
  await sock.groupParticipantsUpdate(jid, numberJids, "demote");
}

/** Toggles whether non-admin members may send messages ("announcement" mode). */
export async function setMembersCanSendMessage(sock, jid, allow) {
  await sock.groupSettingUpdate(jid, allow ? "not_announcement" : "announcement");
}

/** Toggles whether non-admin members may edit group settings. */
export async function setMembersCanEditSettings(sock, jid, allow) {
  await sock.groupSettingUpdate(jid, allow ? "unlocked" : "locked");
}

/** Toggles whether new members require admin approval to join. */
export async function setJoinApprovalRequired(sock, jid, required) {
  await sock.groupJoinApprovalMode(jid, required ? "on" : "off");
}

/** Controls who may add new members directly. */
export async function setMemberAddMode(sock, jid, mode) {
  await sock.groupMemberAddMode(jid, mode);
}

export async function listPendingJoinRequests(sock, jid) {
  return sock.groupRequestParticipantsList(jid);
}

export async function approveJoinRequests(sock, jid, numberJids) {
  await sock.groupRequestParticipantsUpdate(jid, numberJids, "approve");
}

export async function rejectJoinRequests(sock, jid, numberJids) {
  await sock.groupRequestParticipantsUpdate(jid, numberJids, "reject");
}

/** Sets the disappearing-message timer in seconds (0 disables it). */
export async function setDisappearingTimer(sock, jid, seconds) {
  await sock.groupToggleEphemeral(jid, seconds);
}
