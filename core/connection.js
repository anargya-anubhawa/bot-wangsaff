/**
 * GX-ID — connection layer
 *
 * Creates the Baileys socket, handles pairing-code / QR authentication,
 * reconnect logic, a liveness watchdog, group-event queueing and the
 * anti-call feature. Mirrors the reference architecture's handler while
 * staying focused on GX-ID's feature set.
 */
import {
  makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestWaWebVersion,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import fs from "fs";
import path from "path";
import readline from "readline";
import NodeCache from "node-cache";
import pino from "pino";
import config, { setBotNumber } from "../config.js";
import { logger, logBox } from "../lib/logger.js";
import { extendSocket } from "../lib/socket.js";
import {
  isLid,
  decodeAndNormalize,
  cacheLidJid,
  resolveFromSock,
} from "../lib/lid.js";
import { getDatabase } from "../lib/database.js";

/* ─────────────────────────────── state ─────────────────────────────── */

const connectionState = {
  isConnected: false,
  isReady: false,
  sock: null,
  reconnectAttempts: 0,
  connectedAt: null,
  /**
   * Local time (ms) at which the CURRENT socket reached `open`. Any incoming
   * message whose original timestamp predates this moment was queued while the
   * bot was offline and is dropped instead of being answered — the bot only
   * reacts to messages that arrive after it is actually online.
   */
  onlineSince: null,
  version: null,
};

/**
 * Tolerance (ms) added to the `onlineSince` boundary. WhatsApp message
 * timestamps come from the server while `onlineSince` is local time, so a small
 * window absorbs clock skew plus the few ms between the socket opening and our
 * `open` handler running. Anything older is treated as pre-boot and ignored.
 * Configurable through `MESSAGE_BOOT_GRACE_MS`.
 */
const DEFAULT_BOOT_MESSAGE_GRACE_MS = 5000;

function bootMessageGraceMs() {
  const value = Number(config.messageGate?.bootGraceMs);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_BOOT_MESSAGE_GRACE_MS;
}

/**
 * Should an incoming message be dispatched?
 *
 * The bot only reacts to messages that arrived AFTER it came online. WhatsApp
 * queues every message while the bot is offline and replays them on reconnect,
 * each keeping its ORIGINAL (older) timestamp — so any message older than the
 * moment the socket opened is a pre-boot message and is dropped.
 *
 * `onlineSince` is the local time (ms) the current socket opened; a small grace
 * window absorbs clock skew plus the few ms before our `open` handler runs.
 * When the bot has never been online yet (`onlineSince` null) a plain freshness
 * window is used instead, so an ancient queued message is still ignored.
 *
 * @param {number} msgTimestamp  message time in ms (0 = unknown)
 * @param {number|null} onlineSince  ms the socket opened, or null
 * @param {number} [now]  current time in ms (injectable for tests)
 * @returns {boolean} true when the message should be processed
 */
export function isMessageAfterBoot(msgTimestamp, onlineSince, now = Date.now()) {
  if (!msgTimestamp) return true; // unknown time — cannot prove it is stale
  if (onlineSince) return msgTimestamp >= onlineSince - bootMessageGraceMs();
  return now - msgTimestamp <= 5 * 60 * 1000;
}

/**
 * Monotonic id for the *current* socket. Every handler captures the generation
 * it was created in and bails when a newer connection has superseded it, so a
 * stale socket can never drive reconnects, flip global state, or race the live
 * socket while writing the same creds folder (the old "two sockets → corrupted
 * session → re-pair" bug).
 */
let connectionGeneration = 0;

/** Pending reconnect timer, tracked so a newer reconnect supersedes the old. */
let reconnectTimer = null;

/** Schedule exactly one reconnect; a newer call cancels any pending one. */
function scheduleReconnect(delayMs, options) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startConnection(options).catch((error) => logger.error(`reconnect failed: ${error.message}`));
  }, delayMs);
  if (reconnectTimer.unref) reconnectTimer.unref();
}

const groupCache = new NodeCache({ stdTTL: 300, useClones: false });
const processedMessages = new NodeCache({ stdTTL: 30, useClones: false });
const msgRetryCounterCache = new NodeCache({ stdTTL: 60, useClones: false });

let lastMessageReceived = Date.now();
let watchdogTimer = null;
const WATCHDOG_TIMEOUT = 30 * 60 * 1000;
const WATCHDOG_CHECK_INTERVAL = 60 * 1000;

const STATUS_MESSAGES = {
  400: "Bad Request — invalid request, try restarting",
  401: "Unauthorized — session expired, please re-login",
  403: "Forbidden — access denied by WhatsApp, check the number",
  404: "Not Found — resource missing",
  405: "Method Not Allowed — operation not permitted",
  408: "Timeout — connection timed out, check your internet",
  410: "Gone — session removed server-side, restart",
  428: "Connection Required — reconnect needed",
  440: "Session Conflict — logged in on another device",
  500: "Internal Server Error — WhatsApp server error",
  501: "Not Implemented — feature unsupported by server",
  502: "Bad Gateway — WhatsApp server not responding",
  503: "Service Unavailable — WhatsApp under maintenance",
  504: "Gateway Timeout — WhatsApp server too slow",
  515: "Restart Required — WhatsApp requested a restart",
};

/* ─────────────────────────────── store ─────────────────────────────── */

const store = {
  messages: new Map(),
  chats: new Map(),
  contacts: {},
  bind(ev) {
    ev.on("messages.upsert", ({ messages: msgs }) => {
      for (const msg of msgs) {
        const jid = msg.key?.remoteJid;
        if (!jid) continue;
        if (!this.messages.has(jid)) this.messages.set(jid, new Map());
        const chat = this.messages.get(jid);
        if (msg.key?.id) {
          chat.set(msg.key.id, msg);
          if (chat.size > 200) {
            const keys = [...chat.keys()];
            for (let i = 0; i < keys.length - 150; i++) chat.delete(keys[i]);
          }
        }
        if (msg.key?.participantAlt && msg.key?.participant) {
          const alt = decodeAndNormalize(msg.key.participantAlt);
          const primary = decodeAndNormalize(msg.key.participant);
          if (alt && primary && !isLid(alt)) cacheLidJid(primary, alt);
        }
        if (msg.key?.remoteJidAlt && msg.key?.remoteJid) {
          const alt = decodeAndNormalize(msg.key.remoteJidAlt);
          const primary = decodeAndNormalize(msg.key.remoteJid);
          if (alt && primary && !isLid(alt)) cacheLidJid(primary, alt);
        }
        if (!this.chats.has(jid)) this.chats.set(jid, { id: jid });
        if (msg.pushName && jid.endsWith("@s.whatsapp.net")) {
          this.contacts[jid] = { ...this.contacts[jid], notify: msg.pushName };
        }
      }
    });
    ev.on("chats.upsert", (chats) => {
      for (const chat of chats) if (chat.id) this.chats.set(chat.id, chat);
    });
    ev.on("contacts.upsert", (contacts) => {
      for (const contact of contacts) {
        if (contact.id) this.contacts[contact.id] = { ...this.contacts[contact.id], ...contact };
      }
    });
  },
  async loadMessage(jid, id) {
    return this.messages.get(jid)?.get(id) || undefined;
  },
};

/* ─────────────────────────────── logger ─────────────────────────────── */

const silentLogger = pino({
  level: "silent",
  hooks: {
    logMethod(inputArgs, method) {
      const msg = inputArgs[0];
      if (
        typeof msg === "string" &&
        (msg.includes("Closing") ||
          msg.includes("session") ||
          msg.includes("SessionEntry") ||
          msg.includes("prekey") ||
          msg.includes("Bad MAC"))
      ) {
        return;
      }
      return method.apply(this, inputArgs);
    },
  },
});

/* ─────────────────────────────── readline ─────────────────────────────── */

let rl = null;

function askQuestion(question) {
  return new Promise((resolve) => {
    if (rl) rl.close();
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      rl = null;
      resolve(answer.trim());
    });
  });
}

/* ─────────────────────────────── watchdog ─────────────────────────────── */

function startWatchdog(restart) {
  if (watchdogTimer) clearInterval(watchdogTimer);
  lastMessageReceived = Date.now();
  watchdogTimer = setInterval(() => {
    const silentMs = Date.now() - lastMessageReceived;
    if (silentMs > WATCHDOG_TIMEOUT && connectionState.isReady) {
      logger.warn("watchdog — no incoming messages, refreshing connection");
      connectionState.isReady = false;
      connectionState.isConnected = false;
      stopWatchdog();
      // A half-dead socket frequently never emits `connection.close`, so merely
      // ending it is not enough — we must actively start a fresh connection,
      // otherwise the bot sits there forever ("bengong") until a manual restart.
      if (typeof restart === "function") restart();
      else scheduleReconnect(1000, {});
    }
  }, WATCHDOG_CHECK_INTERVAL);
  if (watchdogTimer.unref) watchdogTimer.unref();
  logger.connection(`watchdog active (idle limit ${WATCHDOG_TIMEOUT / 60000} min)`);
}

function stopWatchdog() {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}

/* ─────────────────────────── pairing helpers ─────────────────────────── */

/**
 * Normalise a phone number for `requestPairingCode`. Returns digits only.
 * Values that clearly aren't phone numbers (too short) yield `""`.
 */
export function normalizePairingNumber(...candidates) {
  for (const candidate of candidates) {
    const digits = String(candidate || "").replace(/[^0-9]/g, "");
    if (digits.length >= 7) return digits;
  }
  return "";
}

/**
 * Validate an optional 8-char custom pairing code. WhatsApp uses Crockford
 * base32 (no I, L, O, U). Returns `undefined` when invalid/empty so Baileys
 * generates a random code.
 */
export function normalizeCustomPairingCode(raw) {
  const code = String(raw || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (!code) return undefined;
  if (code.length !== 8 || /[ILOU]/.test(code)) return undefined;
  return code;
}

/* ─────────────────────────────── connection ─────────────────────────────── */

export async function startConnection(options = {}) {
  const generation = ++connectionGeneration;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  // Tear the previous socket down COMPLETELY (socket + its listeners) before a
  // new one is created. Leaving the old listeners attached let a stale socket
  // drive reconnects and — worse — write to the same creds folder concurrently,
  // which corrupted the session and forced a re-pair.
  if (connectionState.sock) {
    try {
      connectionState.sock.ev?.removeAllListeners?.();
    } catch {
      /* ignore */
    }
    try {
      connectionState.sock.end(new Error("superseded by a newer connection"));
    } catch {
      /* ignore */
    }
    connectionState.sock = null;
  }
  connectionState.isConnected = false;
  connectionState.isReady = false;
  connectionState.onlineSince = null;

  const sessionPath = path.join(process.cwd(), "storage", config.session?.folderName || "session");
  if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

  let version;
  try {
    // Never let version discovery stall the boot — a hung request here is one
    // of the reasons the bot appeared to "just sit there" after a restart.
    const latest = await Promise.race([
      fetchLatestWaWebVersion(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("version lookup timed out")), 8000),
      ),
    ]);
    version = latest.version;
  } catch {
    version = [2, 3000, 1035194821];
  }
  connectionState.version = version;

  const usePairingCode = config.session?.usePairingCode === true;
  let pairingAttempted = false;
  let pairingFailed = false;
  let allowQR = !usePairingCode;

  const sock = makeWASocket({
    version,
    logger: silentLogger,
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, silentLogger),
    },
    browser: ["Ubuntu", "Chrome", "20.0.04"],
    syncFullHistory: false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
    // Explicit timeouts: without these a stalled handshake or an unanswered
    // request can leave the socket half-open (connected but silent).
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 25000,
    defaultQueryTimeoutMs: 60000,
    retryRequestDelayMs: 2000,
    maxMsgRetryCount: 5,
    shouldIgnoreJid: (jid) => (jid ? jid.includes("meta_ai") : false),
    getMessage: async (key) => {
      const stored = await store.loadMessage(key.remoteJid, key.id);
      return stored?.message || undefined;
    },
    cachedGroupMetadata: async (jid) => {
      const cached = groupCache.get(jid);
      if (cached) return cached;
      try {
        const fresh = await sock.groupMetadata(jid);
        groupCache.set(jid, fresh);
        return fresh;
      } catch {
        return undefined;
      }
    },
    msgRetryCounterCache,
  });

  store.bind(sock.ev);
  sock.store = store;

  connectionState.sock = sock;
  extendSocket(sock);

  /* ── pairing code ──
   * `requestPairingCode(phoneNumber, customCode)` — the 2nd argument is an
   * OPTIONAL 8-char custom pairing code, NOT the phone number. We only forward
   * it when it is a valid Crockford code, otherwise Baileys generates one.
   *
   * The request is issued on the first `connection.update` that carries a QR
   * (i.e. the websocket is up and ready). If it fails we transparently fall
   * back to QR login.
   */
  let resolvedPhone = null;
  const resolvePairingNumber = async () => {
    if (resolvedPhone !== null) return resolvedPhone;
    // Prefer PAIRING_NUMBER, then BOT_NUMBER. Values that don't look like a
    // phone number (e.g. an accidental custom-code string) are ignored.
    let phoneNumber = normalizePairingNumber(
      config.session?.pairingNumber,
      config.bot?.number,
    );
    if (!phoneNumber) {
      // A readline prompt needs an interactive terminal. Under pm2/systemd/Docker
      // (no TTY) `rl.question` never resolves, which left the bot hanging
      // forever before it ever connected. Detect that and fall back to QR.
      if (!process.stdin.isTTY) {
        logger.warn(
          "pairing number not set and no interactive terminal — falling back to QR login",
        );
        return "";
      }
      logger.warn("pairing number not set in config — please enter it now");
      phoneNumber = (await askQuestion("📱 Enter WhatsApp number (e.g. 6281234567890): ")).replace(/[^0-9]/g, "");
    }
    resolvedPhone = phoneNumber;
    return resolvedPhone;
  };

  const customPairingCode = normalizeCustomPairingCode(config.session?.pairingCode);
  if (config.session?.pairingCode && !customPairingCode) {
    logger.warn("PAIRING_CODE must be exactly 8 chars (A-Z, 2-7; no I/L/O/U) — ignoring it");
  }

  async function requestPairing() {
    if (pairingAttempted || pairingFailed) return;
    pairingAttempted = true;
    const phoneNumber = await resolvePairingNumber();
    if (!phoneNumber) {
      logger.error("pairing aborted — no valid phone number; falling back to QR");
      pairingFailed = true;
      allowQR = true;
      return;
    }
    logger.info(`requesting pairing code for ${phoneNumber}`);
    try {
      const code = await sock.requestPairingCode(phoneNumber, customPairingCode);
      logBox("PAIRING CODE", [
        `code   : ${code}`,
        "how-to : WhatsApp > Settings > Linked Devices > Link a Device",
      ]);
    } catch (error) {
      logger.error(`pairing failed: ${error.message} — falling back to QR`);
      pairingFailed = true;
      allowQR = true;
    }
  }

  sock.ev.on("creds.update", async () => {
    // A superseded socket must never overwrite the live session's credentials —
    // that race is what corrupted the session and forced a re-pair.
    if (generation !== connectionGeneration) return;
    await saveCreds();
  });

  /* ── connection updates ── */
  sock.ev.on("connection.update", async (update) => {
    // A superseded socket must never drive reconnects or flip global state.
    if (generation !== connectionGeneration) return;

    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      // A QR is only emitted once the websocket is live — the ideal moment to
      // issue a pairing code. Baileys keeps emitting new QRs, so we guard with
      // `pairingAttempted` / `pairingFailed` inside `requestPairing()`.
      const wantPairing = usePairingCode && !pairingFailed && !sock.authState.creds.registered;
      if (wantPairing) {
        requestPairing().catch((e) => logger.error(`pairing error: ${e.message}`));
      } else if (allowQR || pairingFailed) {
        logger.info("QR ready — scan to log in");
        try {
          const { default: qrcode } = await import("qrcode");
          const qrText = await qrcode.toString(qr, { type: "terminal", small: true });
          console.log(qrText);
        } catch (e) {
          logger.error(`failed to render QR: ${e.message}`);
        }
      }
    }

    if (connection === "close") {
      connectionState.isConnected = false;
      connectionState.isReady = false;
      connectionState.onlineSince = null;
      stopWatchdog();

      const statusCode = (lastDisconnect?.error instanceof Boom
        ? lastDisconnect.error.output?.statusCode
        : lastDisconnect?.error?.output?.statusCode) ?? undefined;

      const shouldReconnect =
        statusCode !== DisconnectReason.loggedOut && statusCode !== 401;

      const statusMsg = STATUS_MESSAGES[statusCode] || `Unknown (code: ${statusCode})`;
      logger.warn(`disconnected — ${statusMsg}`);

      if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
        logger.error("session expired — delete the session folder and restart");
        connectionState.reconnectAttempts = 0;
        return;
      }

      if (statusCode === 440) {
        connectionState.reconnectAttempts++;
        if (connectionState.reconnectAttempts <= 3) {
          logger.info(`reconnecting ${connectionState.reconnectAttempts}/3 in 10s`);
          scheduleReconnect(10000, options);
        } else {
          logger.error("session conflict — another device detected, stop the other bot");
          connectionState.reconnectAttempts = 0;
        }
        return;
      }

      if (shouldReconnect) {
        connectionState.reconnectAttempts++;
        const max = config.session?.maxReconnectAttempts || 5;
        if (connectionState.reconnectAttempts <= max) {
          logger.info(`reconnecting ${connectionState.reconnectAttempts}/${max}`);
          scheduleReconnect(config.session?.reconnectInterval || 15000, options);
        } else {
          // Never give up for good — a zombie process that silently stops
          // reconnecting is exactly the "bot bengong" symptom. Keep retrying on
          // a slower cadence so the bot recovers on its own once the network or
          // WhatsApp recovers.
          const backoff = Math.min(connectionState.reconnectAttempts - max, 12) * 15000;
          logger.warn(
            `reconnect attempt ${connectionState.reconnectAttempts} failed — retrying in ${Math.round(backoff / 1000)}s`,
          );
          scheduleReconnect(backoff, options);
        }
      } else {
        connectionState.reconnectAttempts = 0;
      }
    }

    if (connection === "open") {
      connectionState.isConnected = true;
      connectionState.isReady = true;
      connectionState.reconnectAttempts = 0;
      connectionState.connectedAt = new Date();
      /* Everything older than this is a message queued while the bot was
         offline — recorded now so the pipeline can drop pre-boot messages. */
      connectionState.onlineSince = Date.now();

      try {
        await sock.uploadPreKeys();
      } catch {
        /* ignore */
      }

      const number = sock.user?.id?.split(":")[0] || sock.user?.id?.split("@")[0];
      if (number) setBotNumber(number);

      logger.success(`connected as ${number} · WA v${(version || []).join(".")}`);
      logger.connection("ready to receive messages");

      startWatchdog(() => {
        logger.warn("watchdog is restarting the connection");
        startConnection(options).catch((error) =>
          logger.error(`watchdog restart failed: ${error.message}`),
        );
      });

      if (options.onConnectionUpdate) await options.onConnectionUpdate(update, sock);
    }

    if (options.onConnectionUpdate && connection !== "close" && connection !== "open") {
      await options.onConnectionUpdate(update, sock);
    }
  });

  /* ── group event queue ── */
  const groupEventQueue = [];
  let groupEventProcessing = false;
  const connectedAt = Date.now();

  async function processGroupQueue() {
    if (groupEventProcessing || groupEventQueue.length === 0) return;
    groupEventProcessing = true;
    while (groupEventQueue.length > 0) {
      const { handler, args } = groupEventQueue.shift();
      try {
        await handler(...args);
      } catch (e) {
        if (e?.message?.includes("rate-overlimit") || e?.output?.statusCode === 429) {
          logger.warn("rate-limit — throttled, waiting 5s");
          await new Promise((r) => setTimeout(r, 5000));
          try {
            await handler(...args);
          } catch {
            /* ignore */
          }
        }
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    groupEventProcessing = false;
  }

  sock.ev.on("groups.update", async (updates) => {
    for (const update of updates) {
      try {
        const m = await sock.groupMetadata(update.id);
        groupCache.set(update.id, m);
      } catch {
        /* ignore */
      }
      if (options.onGroupUpdate) {
        groupEventQueue.push({ handler: options.onGroupUpdate, args: [update, sock] });
        processGroupQueue();
      }
    }
  });

  sock.ev.on("group-participants.update", async (event) => {
    if (Date.now() - connectedAt < 15000) return;
    if (options.onParticipantsUpdate) {
      groupEventQueue.push({ handler: options.onParticipantsUpdate, args: [event, sock] });
      processGroupQueue();
    }
  });

  sock.ev.on("messages.update", async (updates) => {
    if (options.onMessageUpdate) await options.onMessageUpdate(updates, sock);
  });

  /* ── message pipeline ── */
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    // Ignore events from a socket that has already been superseded.
    if (generation !== connectionGeneration) return;

    lastMessageReceived = Date.now();
    if (type !== "notify" && type !== "append") return;

    // NOTE: we deliberately do NOT drop messages merely because `isReady` is
    // still false — WhatsApp flushes a burst of `notify` messages the instant
    // the socket opens, often a tick before our own `open` handler flips the
    // flag. Instead we gate on the message's own timestamp (see
    // `isMessageAfterBoot` below), which correctly separates genuinely-new
    // messages from the backlog WhatsApp replays on reconnect.
    const currentSock = connectionState.sock;
    if (!currentSock) return;

    for (const msg of messages) {
      if (!msg.message) continue;

      const msgId = msg.key?.id;
      if (msgId && processedMessages.has(msgId)) continue;
      if (msgId) processedMessages.set(msgId, true);

      let msgTimestamp = 0;
      if (msg.messageTimestamp) {
        msgTimestamp =
          typeof msg.messageTimestamp.toNumber === "function"
            ? msg.messageTimestamp.toNumber() * 1000
            : Number(msg.messageTimestamp) * 1000;
      }

      /* Only react to messages that arrived AFTER the bot came online. While the
         bot is offline WhatsApp queues everything and replays it on reconnect,
         and every replayed message keeps its ORIGINAL (older) timestamp. Any
         message older than the moment this socket opened is therefore a pre-boot
         message and must not be answered. */
      if (!isMessageAfterBoot(msgTimestamp, connectionState.onlineSince)) continue;

      const metadataKeys = ["senderKeyDistributionMessage", "messageContextInfo"];
      const msgType =
        Object.keys(msg.message).find((k) => !metadataKeys.includes(k)) || Object.keys(msg.message)[0];

      // A `protocolMessage` is normally skipped, EXCEPT a REVOKE (a user deleting
      // their own message) which we forward so the event log can record it.
      if (msgType === "protocolMessage") {
        const proto = msg.message.protocolMessage;
        if (proto?.type === 0 && proto.key?.id && options.onMessage) {
          options.onMessage(msg, currentSock).catch((error) => {
            logger.error(`revoke handler: ${error.message}`);
          });
        }
        continue;
      }

      const ignoredTypes = [
        "protocolMessage",
        "reactionMessage",
        "senderKeyDistributionMessage",
        "stickerSyncRmrMessage",
        "encReactionMessage",
        "keepInChatMessage",
        "deviceSentMessage",
        "call",
        "peerDataOperationRequestMessage",
        "bcallMessage",
      ];
      if (ignoredTypes.includes(msgType)) continue;

      let jid = msg.key.remoteJid || "";

      if (msg.key.fromMe && type === "append" && jid !== "status@broadcast") continue;
      if (jid === "status@broadcast") continue;
      if (jid.endsWith("@broadcast")) continue;

      if (isLid(jid)) {
        const resolved = await resolveFromSock(jid, currentSock);
        if (resolved && !isLid(resolved)) {
          jid = resolved;
          msg.key.remoteJid = jid;
        }
      }
      if (msg.key.participant && isLid(msg.key.participant)) {
        const resolved = await resolveFromSock(msg.key.participant, currentSock);
        if (resolved && !isLid(resolved)) msg.key.participant = resolved;
      }

      if (!jid || jid === "undefined" || jid.length < 5) continue;

      if (options.onMessage) {
        options.onMessage(msg, currentSock).catch((error) => {
          logger.error(`message handler: ${error.message}`);
        });
      }
    }
  });

  /* ── anti-call ── */
  {
    let antiCall = config.features?.antiCall;
    try {
      const db = getDatabase();
      antiCall = db.setting("antiCall") ?? antiCall;
    } catch {
      /* database may not be ready */
    }
    if (antiCall) {
      sock.ev.on("call", async (calls) => {
        for (const call of calls) {
          if (call.status !== "offer") continue;
          logger.warn(`rejecting call from ${call.from}`);
          try {
            await sock.rejectCall(call.id, call.from);
            await sock.sendMessage(call.from, { text: config.messages?.rejectCall || "🚫 Please don't call the bot." });
            if (config.features?.blockIfCall) {
              let target = call.from;
              if (target.endsWith("@lid")) {
                const pn = await resolveFromSock(target, sock);
                if (pn && !isLid(pn)) target = pn;
              }
              if (!target.endsWith("@lid")) {
                await sock.updateBlockStatus(target.split("@")[0], "block").catch(() => {});
              }
            }
          } catch (e) {
            logger.error(`anti-call failed: ${e.message}`);
          }
        }
      });
    }
  }

  process.nextTick(() => {
    try {
      sock.ev?.flush?.();
    } catch {
      /* ignore */
    }
  });

  return sock;
}

/* ─────────────────────────────── accessors ─────────────────────────────── */

export function getSocket() {
  return connectionState.sock;
}

export function isConnected() {
  return connectionState.isConnected;
}

/**
 * Wait until the socket reports `open`, or until `timeoutMs` elapses.
 *
 * The post-boot console must not take over stdin while the pairing-code prompt
 * (also readline on stdin) may still be pending, so it waits for the connection
 * to be ready first. Resolves `true` as soon as we are connected, `false` when
 * the timeout expires first (`timeoutMs <= 0` waits forever).
 *
 * @param {number} [timeoutMs=120000]
 * @param {number} [intervalMs=500]
 * @returns {Promise<boolean>}
 */
export function waitForConnection(timeoutMs = 120000, intervalMs = 500) {
  if (connectionState.isConnected) return Promise.resolve(true);
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (connectionState.isConnected) {
        clearInterval(timer);
        resolve(true);
        return;
      }
      if (timeoutMs > 0 && Date.now() - startedAt >= timeoutMs) {
        clearInterval(timer);
        resolve(false);
      }
    }, intervalMs);
  });
}

export function getUptime() {
  if (!connectionState.connectedAt) return 0;
  return Date.now() - connectionState.connectedAt.getTime();
}

export async function logout() {
  try {
    const sessionPath = path.join(process.cwd(), "storage", config.session?.folderName || "session");
    if (connectionState.sock) await connectionState.sock.logout();
    if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
    connectionState.isConnected = false;
    connectionState.sock = null;
    connectionState.connectedAt = null;
    logger.success("logged out and session removed");
    return true;
  } catch (error) {
    logger.error(`logout failed: ${error.message}`);
    return false;
  }
}
