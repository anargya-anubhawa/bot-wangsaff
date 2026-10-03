/**
 * GX-ID — XMPP bridge manager (singleton)
 *
 * Owns the single `XmppClient`, the `Bridge` wiring and the runtime bridge
 * state. The bridge state (enabled flag + group list) lives in the bot's EXISTING
 * database under the settings key `xmppBridge`, so `.xmpp setgroup` takes effect
 * without a restart and no new database is introduced.
 *
 *   { enabled: boolean, groups: string[] }
 *
 * `config/xmpp.js` only *seeds* the group list (and the enabled default) on first
 * boot; the database is the source of truth afterwards.
 */
import xmppConfig, { getAccount, isConfigured } from "../../config/xmpp.js";
import { logger } from "../logger.js";
import { getDatabase } from "../database.js";
import { XmppClient, XMPP_STATUS } from "./client.js";
import { createBridge } from "./bridge.js";

const SETTING_KEY = "xmppBridge";

/** @type {XmppClient|null} */
let client = null;
/** @type {ReturnType<typeof createBridge>|null} */
let bridge = null;
let started = false;

/* ─────────────────────────── bridge state (database-backed) ─────────────────────────── */

function readSetting() {
  try {
    const value = getDatabase().setting(SETTING_KEY);
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function writeSetting(patch) {
  const db = getDatabase();
  const current = readSetting();
  const next = { ...current, ...patch };
  db.setting(SETTING_KEY, next);
  return next;
}

/**
 * Current bridge state, merging the database over the config seed.
 * @returns {{ enabled: boolean, groups: string[] }}
 */
export function getBridgeState() {
  const stored = readSetting();
  const enabled = stored.enabled === undefined ? !!xmppConfig.enabled : !!stored.enabled;
  const groups = Array.isArray(stored.groups)
    ? stored.groups.map(String)
    : (xmppConfig.bridgeGroups || []).map(String);
  return { enabled, groups };
}

/** Turn the bridge on/off at runtime. */
export function setBridgeEnabled(enabled) {
  return writeSetting({ enabled: !!enabled });
}

/** Every configured bridge group JID. */
export function getBridgeGroups() {
  return getBridgeState().groups;
}

/** Add a group to the bridge (idempotent). Returns the new list. */
export function addBridgeGroup(jid) {
  const value = String(jid || "").trim();
  if (!value) return getBridgeGroups();
  const groups = getBridgeGroups();
  if (!groups.includes(value)) groups.push(value);
  writeSetting({ groups });
  return groups;
}

/** Remove a group from the bridge. Returns the new list. */
export function removeBridgeGroup(jid) {
  const value = String(jid || "").trim();
  const groups = getBridgeGroups().filter((g) => g !== value);
  writeSetting({ groups });
  return groups;
}

/** Seed the database from `config/xmpp.js` when it has no group list yet. */
export function seedBridgeState() {
  const stored = readSetting();
  if (!Array.isArray(stored.groups) && (xmppConfig.bridgeGroups || []).length) {
    writeSetting({ groups: xmppConfig.bridgeGroups.map(String) });
  }
}

/* ─────────────────────────── lifecycle ─────────────────────────── */

/** Snapshot of the connection for status commands / logs. Never leaks secrets. */
export function getXmppStatus() {
  const { enabled, groups } = getBridgeState();
  return {
    enabled,
    groups,
    status: client ? client.status : XMPP_STATUS.IDLE,
    connected: !!client?.isConnected,
    server: xmppConfig.host ? `${xmppConfig.host}:${xmppConfig.port}` : "",
    account: getAccount(),
    room: xmppConfig.room || "",
    target: xmppConfig.room || xmppConfig.to || "",
    configured: isConfigured(),
  };
}

/**
 * Start the XMPP bridge. Best-effort: any failure logs and returns `false` so
 * WhatsApp keeps running (requirement: XMPP must never crash the bot).
 *
 * @param {object} deps
 * @param {Function} deps.getSocket  () => WhatsApp socket | null
 * @returns {Promise<boolean>} whether a connection attempt was started
 */
export async function startXmppBridge({ getSocket } = {}) {
  if (started) return true;

  seedBridgeState();

  if (!xmppConfig.enabled) {
    logger.system("[XMPP] bridge disabled (XMPP_ENABLED=false)");
    return false;
  }
  if (!isConfigured()) {
    logger.warn("[XMPP] bridge enabled but XMPP_HOST/USERNAME/PASSWORD are incomplete — skipping");
    return false;
  }

  bridge = createBridge({
    config: xmppConfig,
    getSocket,
    getBridgeState,
    sendXmpp: (text) => client.send(text),
    logger,
  });

  client = new XmppClient(xmppConfig, { logger });

  client.on("message", (msg) => {
    Promise.resolve(bridge.handleMinecraftMessage(msg)).catch((error) =>
      logger.error(`[XMPP → WA] ${error?.message || error}`),
    );
  });

  client.on("status", (status) => logger.debug?.(`[XMPP] status ${status}`));

  started = true;
  logger.info("[BOOT] Starting XMPP bridge…");
  // Do not await the full handshake — WhatsApp must not wait on XMPP.
  client.connect().catch((error) => logger.error(`[XMPP] ${error?.message || error}`));
  return true;
}

/** Stop the bridge and close the connection (graceful shutdown). */
export async function stopXmppBridge() {
  started = false;
  const current = client;
  client = null;
  bridge = null;
  if (current) {
    logger.system("[XMPP] Disconnecting…");
    try {
      await current.stop();
    } catch {
      /* ignore */
    }
  }
}

/** True once `startXmppBridge` has run. */
export function isBridgeStarted() {
  return started;
}

/**
 * Relay a WhatsApp message to Minecraft. Called by the message pipeline for
 * non-command messages; a no-op when the bridge is off or the message is not a
 * bridge-group text message.
 */
export async function relayWhatsAppToMinecraft(m) {
  if (!started || !bridge) return false;
  try {
    return await bridge.relayWhatsAppToMinecraft(m);
  } catch (error) {
    logger.error(`[WA → XMPP] ${error?.message || error}`);
    return false;
  }
}

/** Expose the rate limiter (tests / diagnostics). */
export function getBridgeInternals() {
  return { client, bridge };
}
