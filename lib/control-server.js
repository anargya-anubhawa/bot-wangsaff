/**
 * GX-ID — control server (in-bot)
 *
 * Listens on a local IPC socket (named pipe on Windows / unix socket elsewhere)
 * so a console client running in ANOTHER terminal can drive the bot:
 *
 *   • stream the bot's log feed;
 *   • list group / private-chat targets;
 *   • send a message to a chat;
 *   • broadcast to all registered groups or a chosen subset;
 *   • stream the incoming conversation of a selected chat;
 *   • report live status (clock, uptime, ping, memory, groups, connection);
 *   • request a restart or a full shutdown.
 *
 * The bot itself keeps printing its logs to its own terminal exactly as before
 * — this server only *adds* a channel; with no client connected it is inert.
 *
 * Wire format: newline-delimited JSON. Each line is either a request
 * `{ "id": <n>, "type": "<cmd>", ... }` or an event `{ "event": "<name>", ... }`.
 */
import fs from "fs";
import net from "net";
import { logger } from "./logger.js";
import { onLog } from "./log-bus.js";
import { onIncoming } from "./console-bus.js";
import { controlPath, collectGroups, wsPing } from "./control-utils.js";
import { getSocket, getUptime, isConnected } from "../core/connection.js";
import { getDatabase } from "./database.js";
import { restartBot, shutdownResources } from "./restart.js";
const BROADCAST_DELAY_MS = 400;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Remove a stale socket file left by a previous crashed run. */
function cleanupSocketFile(target) {
  if (process.platform === "win32") return;
  try {
    if (fs.existsSync(target)) fs.unlinkSync(target);
  } catch {
    /* ignore */
  }
}

/** A single connected console client. */
class ControlClient {
  constructor(socket, server) {
    this.socket = socket;
    this.server = server;
    this.buffer = "";
    this.watching = null; // chat JID whose conversation is streamed
    this.socket.setEncoding("utf8");
    this.socket.on("data", (chunk) => this._onData(chunk));
    this.socket.on("error", () => this.close());
    this.socket.on("close", () => this.close());
  }

  send(obj) {
    if (this.socket.destroyed) return;
    try {
      this.socket.write(`${JSON.stringify(obj)}\n`);
    } catch {
      /* ignore */
    }
  }

  _onData(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      this._handle(message).catch((error) => {
        this.send({ id: message.id, ok: false, error: error?.message || String(error) });
      });
    }
  }

  async _handle(message) {
    const { id, type } = message;
    switch (type) {
      case "ping":
        return this.send({ id, ok: true, pong: Date.now() });
      case "status":
        return this.send({ id, ok: true, status: await this.server.status() });
      case "targets":
        return this.send({ id, ok: true, targets: this.server.targets() });
      case "send":
        return this._send(id, message.jid, message.text);
      case "broadcast":
        return this._broadcast(id, message);
      case "watch":
        this.watching = message.jid || null;
        return this.send({ id, ok: true, watching: this.watching });
      case "restart":
        this.send({ id, ok: true, action: "restart" });
        this.server.requestRestart();
        return undefined;
      case "shutdown":
        this.send({ id, ok: true, action: "shutdown" });
        this.server.requestShutdown();
        return undefined;
      default:
        return this.send({ id, ok: false, error: `unknown request: ${type}` });
    }
  }

  async _send(id, jid, text) {
    const sock = this.server._getSocket();
    if (!sock) return this.send({ id, ok: false, error: "socket unavailable" });
    const target = String(jid || "").trim();
    if (!target) return this.send({ id, ok: false, error: "no target" });
    try {
      await sock.sendText(target, String(text ?? ""));
      return this.send({ id, ok: true });
    } catch (error) {
      return this.send({ id, ok: false, error: error?.message || String(error) });
    }
  }

  async _broadcast(id, message) {
    const sock = this.server._getSocket();
    if (!sock) return this.send({ id, ok: false, error: "socket unavailable" });

    let jids = Array.isArray(message.jids) && message.jids.length
      ? message.jids
      : this.server.targets().filter((t) => t.registered).map((t) => t.jid);
    if (!jids.length) return this.send({ id, ok: false, error: "no targets" });

    const text = String(message.text ?? "");
    let sent = 0;
    let failed = 0;
    for (const jid of jids) {
      try {
        await sock.sendText(jid, text);
        sent += 1;
        this.send({ event: "broadcast-progress", jid, ok: true, sent, failed });
      } catch (error) {
        failed += 1;
        this.send({ event: "broadcast-progress", jid, ok: false, error: error?.message, sent, failed });
      }
      await sleep(BROADCAST_DELAY_MS);
    }
    return this.send({ id, ok: true, sent, failed });
  }

  /** Push an incoming message when this client is watching that chat. */
  notifyIncoming(info) {
    if (!this.watching || !info || info.chat !== this.watching) return;
    this.send({ event: "incoming", message: info });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.server.clients.delete(this);
    try {
      this.socket.destroy();
    } catch {
      /* ignore */
    }
  }
}

export class ControlServer {
  /**
   * @param {object} [options]
   * @param {string} [options.path]  control socket path (defaults to the bot's)
   * @param {() => any} [options.getSocket]
   * @param {() => any} [options.getDb]
   * @param {() => number} [options.getUptime]
   * @param {() => boolean} [options.isConnected]
   */
  constructor(options = {}) {
    this.server = null;
    this.clients = new Set();
    this.path = options.path || controlPath();
    this._unsubLog = null;
    this._unsubIncoming = null;
    this._onRestart = null;
    this._onShutdown = null;
    this._getSocket = options.getSocket || getSocket;
    this._getDb = options.getDb || (() => {
      try {
        return getDatabase();
      } catch {
        return null;
      }
    });
    this._getUptime = options.getUptime || getUptime;
    this._isConnected = options.isConnected || isConnected;
  }

  /**
   * @param {object} [options]
   * @param {() => Promise<any>} [options.onRestart]
   * @param {() => Promise<any>} [options.onShutdown]
   * @returns {Promise<boolean>} true when listening
   */
  async start(options = {}) {
    this._onRestart = options.onRestart || null;
    this._onShutdown = options.onShutdown || null;

    cleanupSocketFile(this.path);

    const server = net.createServer((socket) => {
      const client = new ControlClient(socket, this);
      this.clients.add(client);
      client.send({ event: "hello", bot: "GX-ID", version: process.env.npm_package_version || "1.0.0" });
    });
    this.server = server;

    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.path, () => {
          server.off("error", reject);
          resolve();
        });
      });
    } catch (error) {
      logger.warn(`control server disabled: ${error?.message || error}`);
      return false;
    }

    /* Mirror logs and incoming messages to every connected client. */
    this._unsubLog = onLog((entry) => {
      for (const client of this.clients) client.send({ event: "log", entry });
    });
    this._unsubIncoming = onIncoming((info) => {
      for (const client of this.clients) client.notifyIncoming(info);
    });

    logger.system(`control console listening on ${this.path}`);
    return true;
  }

  /** All known chats (registered groups first). */
  targets() {
    let db = null;
    try {
      db = this._getDb();
    } catch {
      db = null;
    }
    return collectGroups(db);
  }

  /** Live status snapshot for the console footer. */
  async status() {
    const sock = this._getSocket();
    let ping = null;
    if (sock) ping = await wsPing(sock);
    let uptime = 0;
    try {
      uptime = this._getUptime() || 0;
    } catch {
      uptime = 0;
    }
    let connected = false;
    try {
      connected = this._isConnected();
    } catch {
      connected = Boolean(sock);
    }
    return {
      connected,
      uptime,
      ping,
      memory: process.memoryUsage().rss,
      groups: this.targets().length,
      bot: process.env.BOT_NAME || "GX-ID",
      time: Date.now(),
    };
  }

  requestRestart() {
    logger.system("control console requested a restart");
    const handler = this._onRestart || (() => restartBot({ reason: "control console" }));
    Promise.resolve(handler()).catch(() => {});
  }

  requestShutdown() {
    logger.system("control console requested shutdown");
    const handler = this._onShutdown || (async () => {
      await shutdownResources();
      process.exit(0);
    });
    Promise.resolve(handler()).catch(() => {});
  }

  async stop() {
    try {
      this._unsubLog?.();
    } catch {
      /* ignore */
    }
    try {
      this._unsubIncoming?.();
    } catch {
      /* ignore */
    }
    this._unsubLog = null;
    this._unsubIncoming = null;
    for (const client of this.clients) client.close();
    this.clients.clear();
    if (this.server) {
      await new Promise((resolve) => this.server.close(() => resolve()));
      this.server = null;
    }
    cleanupSocketFile(this.path);
    return true;
  }
}

/** Start the control server. Returns the instance (or null when disabled). */
export async function startControlServer(options = {}) {
  const server = new ControlServer(options);
  const ok = await server.start(options);
  return ok ? server : null;
}
