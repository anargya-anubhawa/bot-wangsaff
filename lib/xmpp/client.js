/**
 * GX-ID — XMPP client
 *
 * A single, persistent XMPP connection wrapped in a small lifecycle manager.
 * One connection is created at boot and reused for every message — we never dial
 * a new socket per WhatsApp message.
 *
 * Responsibilities:
 *   • connect to `XMPP_HOST:XMPP_PORT` as `XMPP_USERNAME@XMPP_DOMAIN`
 *   • authenticate, optionally join a MUC room
 *   • emit status transitions (CONNECTING / CONNECTED / AUTHENTICATED /
 *     DISCONNECTED / RECONNECTING / ERROR)
 *   • reconnect automatically with exponential backoff
 *   • never crash the host process when XMPP is down or the library is missing
 *
 * The underlying `@xmpp/client` library is imported lazily so a missing
 * dependency degrades to a clear log line instead of a boot failure.
 */
import { EventEmitter } from "events";

/** Lifecycle states surfaced to the bridge / commands. */
export const XMPP_STATUS = {
  IDLE: "IDLE",
  CONNECTING: "CONNECTING",
  CONNECTED: "CONNECTED",
  AUTHENTICATED: "AUTHENTICATED",
  DISCONNECTED: "DISCONNECTED",
  RECONNECTING: "RECONNECTING",
  ERROR: "ERROR",
};

let libPromise = null;

/**
 * Lazily import `@xmpp/client`. Returns `null` (once, then cached) when the
 * package is not installed so the bot keeps running without the bridge.
 */
export async function loadXmppLib(logger) {
  if (!libPromise) {
    libPromise = import("@xmpp/client")
      .then((mod) => mod)
      .catch((error) => {
        logger?.error?.(`[XMPP] dependency unavailable (${error?.message || error}) — bridge disabled`);
        return null;
      });
  }
  return libPromise;
}

/** Reset the memoised library import (test helper). */
export function resetXmppLib() {
  libPromise = null;
}

export class XmppClient extends EventEmitter {
  /**
   * @param {object} config  `config/xmpp.js` (or compatible)
   * @param {object} [options]
   * @param {(lib: object, options: object) => object} [options.factory]
   *        Builds the raw client. Defaults to `lib.client(options)`; tests inject
   *        a fake emitter here.
   * @param {object} [options.logger]
   */
  constructor(config, options = {}) {
    super();
    this.config = config || {};
    this.logger = options.logger;
    this.factory = options.factory || null;

    /** @type {import("events").EventEmitter|null} */
    this.xmpp = null;
    this.status = XMPP_STATUS.IDLE;

    this._started = false;
    this._attempt = 0;
    this._reconnectTimer = null;
    this._joinedRoom = false;
  }

  /** True while the connection is usable for sending. */
  get isConnected() {
    return this.status === XMPP_STATUS.AUTHENTICATED;
  }

  /** Human label, e.g. `XMPP CONNECTED`. */
  get label() {
    return `XMPP ${this.status}`;
  }

  _setStatus(status, detail) {
    this.status = status;
    this.emit("status", status, detail);
    this.emit(`status:${status}`, detail);
  }

  _log(level, message) {
    const fn = this.logger?.[level];
    if (typeof fn === "function") fn.call(this.logger, message);
  }

  /** Build the raw client through the injected factory or `@xmpp/client`. */
  async _createRaw() {
    const { getService } = await import("../../config/xmpp.js");
    const lib = await loadXmppLib(this.logger);
    if (!lib) return null;

    const opts = {
      service: getService(this.config),
      domain: this.config.domain,
      username: this.config.username,
      password: this.config.password,
      resource: this.config.resource || "gx-id",
    };

    const raw = this.factory ? this.factory(lib, opts) : lib.client(opts);
    // The library ships its own 1s fixed-delay reconnect; disable it so OUR
    // exponential backoff is the only reconnect strategy in play.
    try {
      raw.reconnect?.stop?.();
    } catch {
      /* older builds without an exposed reconnect controller */
    }
    return raw;
  }

  /** Connect (idempotent). Resolves once the first attempt settles. */
  async connect() {
    if (this._started) return;
    this._started = true;
    await this._attemptConnect();
  }

  async _attemptConnect() {
    if (!this._started) return;

    const { host, port } = this.config;
    if (!host) {
      this._log("error", "[XMPP] no host configured (XMPP_HOST) — bridge disabled");
      this._setStatus(XMPP_STATUS.ERROR, new Error("missing XMPP_HOST"));
      return;
    }

    this._setStatus(XMPP_STATUS.CONNECTING);
    this._log("info", `[XMPP] Connecting to ${host}:${port}`);

    let raw;
    try {
      raw = await this._createRaw();
    } catch (error) {
      this._log("error", `[XMPP] Failed to initialise client: ${error?.message || error}`);
      this._setStatus(XMPP_STATUS.ERROR, error);
      this._scheduleReconnect();
      return;
    }
    if (!raw) {
      // Library missing — do not spam reconnects.
      this._started = false;
      return;
    }

    this.xmpp = raw;
    this._wire(raw);

    try {
      // `start()` resolves on 'online' and rejects on connect/auth failure.
      await raw.start();
    } catch (error) {
      this._log("error", `[XMPP] Unable to connect: ${error?.message || error}`);
      this._setStatus(XMPP_STATUS.ERROR, error);
      this._scheduleReconnect();
    }
  }

  _wire(raw) {
    raw.on("online", () => {
      this._attempt = 0;
      this._setStatus(XMPP_STATUS.CONNECTED);
      this._log("info", "[XMPP] Connected");
      this._setStatus(XMPP_STATUS.AUTHENTICATED);
      this._log("info", "[XMPP] Authenticated");
      this._joinRoom().catch((error) =>
        this._log("warn", `[XMPP] room join failed: ${error?.message || error}`),
      );
    });

    raw.on("offline", () => {
      this._joinedRoom = false;
      this._setStatus(XMPP_STATUS.DISCONNECTED);
      this._log("warn", "[XMPP] Disconnected");
      this._scheduleReconnect();
    });

    raw.on("error", (error) => {
      this._setStatus(XMPP_STATUS.ERROR, error);
      this._log("error", `[XMPP] ${error?.message || error}`);
      // 'offline' usually follows and drives the reconnect; schedule anyway in
      // case the transport dies without emitting it.
      this._scheduleReconnect();
    });

    raw.on("stanza", (stanza) => {
      try {
        this._onStanza(stanza);
      } catch (error) {
        this._log("warn", `[XMPP] stanza parse error: ${error?.message || error}`);
      }
    });
  }

  /** Join the configured MUC room (no-op when no room is set). */
  async _joinRoom() {
    const { room, nick } = this.config;
    if (!room || !this.xmpp) return;
    const { xml } = await loadXmppLib(this.logger);
    if (!xml) return;
    await this.xmpp.send(
      xml("presence", { to: `${room}/${nick || "gx-id"}` }, [
        xml("x", { xmlns: "http://jabber.org/protocol/muc" }),
      ]),
    );
    this._joinedRoom = true;
    this._log("info", `[XMPP] Joined room ${room} as ${nick || "gx-id"}`);
  }

  _onStanza(stanza) {
    if (!stanza || typeof stanza.is !== "function") return;
    if (!stanza.is("message")) return;

    const body = stanza.getChildText?.("body");
    if (!body) return;

    const from = stanza.attrs?.from || "";
    const type = stanza.attrs?.type || "chat";

    // Never relay our own traffic (our MUC echo / our own bare JID).
    const account = `${this.config.username}@${this.config.domain}`;
    const resource = from.split("/")[1] || "";
    if (from.split("/")[0] === account) return;
    if (this._joinedRoom && resource && resource === (this.config.nick || "gx-id")) return;

    this.emit("message", { from, type, body });
  }

  _scheduleReconnect() {
    if (!this._started || this._reconnectTimer) return;
    const { minDelayMs = 1000, maxDelayMs = 30000 } = this.config.reconnect || {};
    const delay = Math.min(maxDelayMs, minDelayMs * 2 ** this._attempt);
    this._attempt += 1;

    this._setStatus(XMPP_STATUS.RECONNECTING, delay);
    this._log("info", `[XMPP] Reconnecting in ${Math.round(delay / 1000)} seconds…`);

    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._attemptConnect();
    }, delay);
    this._reconnectTimer.unref?.();
  }

  /**
   * Send a plain-text chat message to the configured target.
   * @throws when the connection is not ready or no target is configured.
   */
  async send(text) {
    if (!this.xmpp || !this.isConnected) {
      throw new Error("XMPP not connected");
    }
    const target = this.config.room || this.config.to;
    if (!target) {
      throw new Error("XMPP target not configured (set XMPP_ROOM or XMPP_TO)");
    }
    const { xml } = await loadXmppLib(this.logger);
    if (!xml) throw new Error("XMPP library unavailable");

    const type = this.config.room ? "groupchat" : "chat";
    await this.xmpp.send(xml("message", { to: target, type }, [xml("body", {}, String(text))]));
  }

  /** Disconnect and stop reconnecting. Safe to call repeatedly. */
  async stop() {
    this._started = false;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    const raw = this.xmpp;
    this.xmpp = null;
    this._joinedRoom = false;
    if (raw) {
      try {
        await raw.stop();
      } catch {
        /* already gone */
      }
    }
    this._setStatus(XMPP_STATUS.IDLE);
  }
}
