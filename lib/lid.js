/**
 * GX-ID — JID / LID helpers
 *
 * WhatsApp is migrating participants to LID (local identifier) JIDs. These
 * helpers keep a small in-memory + on-disk cache mapping LID → phone-number JID
 * so commands can always resolve a real number when one is available.
 */
import fs from "fs";
import path from "path";

const CACHE_FILE = path.join(process.cwd(), "database", "lid-cache.json");
const lidToJidMap = new Map();
let saveTimer = null;

function loadPersistentCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
      for (const [lid, jid] of Object.entries(data)) {
        if (lid && jid) lidToJidMap.set(lid, jid);
      }
    }
  } catch {
    /* ignore */
  }
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const dir = path.dirname(CACHE_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(CACHE_FILE, JSON.stringify(Object.fromEntries(lidToJidMap)), "utf-8");
    } catch {
      /* ignore */
    }
  }, 5000);
  if (saveTimer.unref) saveTimer.unref();
}

loadPersistentCache();

export function isLid(jid) {
  return typeof jid === "string" && jid.endsWith("@lid");
}

export function isLidConverted(jid) {
  return isLid(jid);
}

export function decodeAndNormalize(jid) {
  if (!jid || typeof jid !== "string") return jid || "";
  return jid.includes(":") ? jid.replace(/:\d+@/, "@") : jid;
}

export function cacheLidJid(lid, jid) {
  if (!lid || !jid) return;
  if (!isLid(lid)) return;
  if (isLid(jid)) return;
  if (lidToJidMap.get(lid) === jid) return;
  lidToJidMap.set(lid, jid);
  scheduleSave();
}

export function getCachedJid(lid) {
  if (!lid) return null;
  return lidToJidMap.get(lid) || null;
}

export function cacheParticipantLids(participants = []) {
  for (const p of participants || []) {
    if (!p) continue;
    const lid = p.lid || (isLid(p.id) ? p.id : null);
    const jid = p.jid || (!isLid(p.id) ? p.id : null) || p.phoneNumber;
    if (lid && jid && !isLid(jid)) cacheLidJid(lid, jid);
  }
}

export function lidToJid(jid) {
  if (!jid || !isLid(jid)) return jid;
  const cached = getCachedJid(jid);
  if (cached) return cached;
  return jid.replace("@lid", "@s.whatsapp.net");
}

export function resolveAnyLidToJid(jid, participants = []) {
  if (!jid || !isLid(jid)) return jid;
  const cached = getCachedJid(jid);
  if (cached) return cached;
  const found = (participants || []).find(
    (p) => p && (p.id === jid || p.lid === jid),
  );
  if (found) {
    const resolved = found.jid || (!isLid(found.id) ? found.id : null) || found.phoneNumber;
    if (resolved && !isLid(resolved)) {
      cacheLidJid(jid, resolved);
      return resolved;
    }
  }
  return jid;
}

export function convertLidArray(jids = [], participants = []) {
  return (jids || []).map((j) => resolveAnyLidToJid(j, participants));
}

export function getParticipantJid(participant) {
  if (!participant) return "";
  if (typeof participant === "string") return resolveAnyLidToJid(participant);
  return (
    resolveAnyLidToJid(participant.jid || "") ||
    resolveAnyLidToJid(participant.id || "") ||
    resolveAnyLidToJid(participant.lid || "") ||
    participant.phoneNumber ||
    ""
  );
}

export function getParticipantJids(participants = []) {
  return (participants || []).map(getParticipantJid).filter(Boolean);
}

export function findParticipantByNumber(participants = [], targetJid) {
  const target = String(targetJid || "").split("@")[0].split(":")[0];
  if (!target) return null;
  return (
    (participants || []).find((p) => {
      const candidates = [p.jid, p.id, p.lid, p.phoneNumber].filter(Boolean);
      return candidates.some((c) => String(c).split("@")[0].split(":")[0] === target);
    }) || null
  );
}

export async function resolveFromSock(jid, sock) {
  if (!jid || !isLid(jid)) return jid;
  const cached = getCachedJid(jid);
  if (cached) return cached;
  try {
    // Bound the lookup: this runs on the hot message path and a stuck
    // `getPNForLID` would otherwise stall the whole upsert batch.
    const lookup = sock?.signalRepository?.lidMapping?.getPNForLID?.(jid);
    if (!lookup) return jid;
    const timeout = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 3000);
      if (timer.unref) timer.unref();
    });
    const pn = await Promise.race([lookup, timeout]);
    if (pn && !isLid(pn)) {
      cacheLidJid(jid, pn);
      return pn;
    }
  } catch {
    /* ignore */
  }
  return jid;
}
