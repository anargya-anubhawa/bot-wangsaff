/**
 * GX-ID — handler compatibility shim
 *
 * This file used to contain a full copy of the connection/message handler that
 * imported the `ourin` Baileys fork (never installed) plus several modules that
 * no longer exist. The real implementation now lives in:
 *
 *   core/connection.js  — socket lifecycle, pairing/QR, reconnect, watchdog
 *   core/message.js     — the message pipeline (`messageHandler`, `runCommand`)
 *
 * It is kept as a thin re-export so legacy callers (e.g. the jadibot manager)
 * that still import from `src/handler.js` keep working, without pulling in any
 * missing dependency.
 */
export {
  startConnection,
  getSocket,
  isConnected,
  getUptime,
  logout,
  isMessageAfterBoot,
  normalizePairingNumber,
  normalizeCustomPairingCode,
} from "../core/connection.js";

export { messageHandler, runCommand, isSpamming } from "../core/message.js";
