/**
 * GX-ID — control console utilities
 *
 * Small, dependency-light helpers shared by the in-bot control server and the
 * separate console client: where the IPC socket lives, how to list chat
 * targets, and the few formatting helpers the UI needs.
 */
import os from "os";
import path from "path";
import { shortJid } from "./console-shared.js";

/**
 * Where the bot listens for a console client.
 *
 * A local named pipe (Windows) / unix domain socket (POSIX) is used so the
 * control channel is reachable only from the same machine and needs no port.
 * Override with `CONSOLE_PIPE`.
 */
export function controlPath() {
  if (process.env.CONSOLE_PIPE) return process.env.CONSOLE_PIPE;
  if (process.platform === "win32") return "\\\\.\\pipe\\gx-id-console";
  return path.join(os.tmpdir(), "gx-id-console.sock");
}

/**
 * Build the list of known chats: registered groups first (from the group
 * registry, falling back to `groups.json`), then any other tracked group.
 *
 * @param {object} db  the database instance (or a compatible fake)
 * @returns {{jid:string,name:string,alias:?string,registered:boolean}[]}
 */
export function collectGroups(db) {
  const out = [];
  const seen = new Set();
  if (!db) return out;

  // 1. registered groups
  let regs = [];
  try {
    regs = db.listRegistrations?.() || [];
  } catch {
    regs = [];
  }
  for (const reg of regs) {
    if (!reg?.jid || (reg.status && reg.status !== "active")) continue;
    if (seen.has(reg.jid)) continue;
    seen.add(reg.jid);
    let g = {};
    try {
      g = db.getGroup?.(reg.jid) || {};
    } catch {
      g = {};
    }
    out.push({
      jid: reg.jid,
      name: reg.name || g.name || shortJid(reg.jid),
      alias: reg.alias || null,
      registered: true,
    });
  }

  // 2. every other group the bot has seen
  let groups = {};
  try {
    groups = db.getAllGroups?.() || {};
  } catch {
    groups = {};
  }
  for (const [jid, g] of Object.entries(groups)) {
    if (seen.has(jid)) continue;
    seen.add(jid);
    out.push({
      jid,
      name: g?.name || shortJid(jid),
      alias: null,
      registered: !!g?.registered,
    });
  }

  return out;
}

/** `1h 02m 03s` style duration from milliseconds. */
export function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

/** MB from bytes, one decimal. */
export function formatMemory(bytes) {
  const mb = (Number(bytes) || 0) / 1024 / 1024;
  return `${mb.toFixed(1)} MB`;
}

/**
 * Measure WebSocket round-trip latency to WhatsApp via a ping/pong frame.
 * Returns the round-trip in ms, or `null` when the socket is not open.
 */
export function wsPing(sock, timeout = 3000) {
  return new Promise((resolve) => {
    const ws = sock?.ws;
    if (!ws || typeof ws.ping !== "function" || ws.readyState !== 1) return resolve(null);
    let done = false;
    const startedAt = Date.now();
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws.off?.("pong", onPong);
      } catch {
        /* ignore */
      }
      resolve(value);
    };
    const onPong = () => finish(Date.now() - startedAt);
    const timer = setTimeout(() => finish(null), timeout);
    try {
      ws.once?.("pong", onPong);
      ws.ping();
    } catch {
      finish(null);
    }
  });
}
