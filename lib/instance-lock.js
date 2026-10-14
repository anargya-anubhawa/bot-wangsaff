/**
 * GX-ID — single-instance lock
 *
 * Guarantees that only ONE bot process ever runs against a given working copy /
 * WhatsApp session. This is what stops the classic VPS failure mode:
 *
 *   bot restarts → the operator thinks it died → they run `npm start` again →
 *   two processes now share the same session → 440 "session conflict", corrupted
 *   creds and a forced re-pair.
 *
 * The lock is a small JSON file (default `./storage/gx-id.lock`, override with
 * `GX_LOCK_FILE`) holding the owner pid and — when the built-in supervisor is
 * active — the worker child pid. A second start refuses to run while either pid
 * is still alive; a lock left behind by a crashed process (dead pid) is taken
 * over automatically.
 */
import fs from "fs";
import path from "path";

/** Where the lock lives. `GX_LOCK_FILE` overrides it. */
export function defaultLockPath(root = process.cwd()) {
  return process.env.GX_LOCK_FILE || path.join(root, "storage", "gx-id.lock");
}

/**
 * Is a process with this pid alive?
 *
 * `process.kill(pid, 0)` performs the permission/existence check without sending
 * a signal. `ESRCH` means "no such process" (dead); `EPERM` means the process
 * exists but belongs to another user (alive, just not ours).
 */
export function isProcessAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/** Parse the lock file. Returns `null` when missing or unreadable. */
function readRaw(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

/**
 * Read the current lock, annotated with liveness.
 *
 * @returns {null | {
 *   pid:number|null, childPid:number|null, startedAt:string|null,
 *   cwd:string|null, argv:string[], label:string,
 *   pidAlive:boolean, childAlive:boolean, alive:boolean
 * }}
 */
export function readLockInfo(file = defaultLockPath()) {
  const data = readRaw(file);
  if (!data) return null;
  const pidAlive = isProcessAlive(data.pid);
  const childAlive = isProcessAlive(data.childPid);
  return {
    pid: data.pid ?? null,
    childPid: data.childPid ?? null,
    startedAt: data.startedAt ?? null,
    cwd: data.cwd ?? null,
    argv: Array.isArray(data.argv) ? data.argv : [],
    label: data.label || "GX-ID",
    pidAlive,
    childAlive,
    alive: pidAlive || childAlive,
  };
}

/** Human-readable description of whoever holds the lock. */
export function describeHolder(info) {
  if (!info) return "unknown process";
  const who = info.childAlive && !info.pidAlive ? "worker" : "supervisor";
  const pid = info.childAlive && !info.pidAlive ? info.childPid : info.pid;
  const parts = [`pid ${pid ?? "?"} (${who})`];
  if (info.startedAt) parts.push(`started ${info.startedAt}`);
  if (info.cwd) parts.push(`cwd ${info.cwd}`);
  return parts.join(", ");
}

/** Create the lock file atomically. Returns `false` when it already exists. */
function tryCreate(file, data) {
  try {
    const fd = fs.openSync(file, "wx");
    try {
      fs.writeSync(fd, JSON.stringify(data, null, 2));
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }
}

/** Overwrite the lock (used to record the worker pid). Atomic via rename. */
function overwrite(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  const payload = JSON.stringify(data, null, 2);
  try {
    fs.writeFileSync(tmp, payload);
    fs.renameSync(tmp, file);
  } catch {
    // Some filesystems refuse renaming over an existing file — fall back to a
    // direct write. The lock is small, so a non-atomic write is acceptable.
    try {
      fs.writeFileSync(file, payload);
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * Acquire the single-instance lock.
 *
 * @param {object} [options]
 * @param {string} [options.file]   lock path (defaults to `defaultLockPath()`).
 * @param {string} [options.label]  bot name, for diagnostics.
 * @returns {{ ok: true, lock: { file:string, setChild:(pid:number|null)=>void, release:()=>void } }
 *          | { ok: false, holder: ReturnType<typeof readLockInfo> }}
 */
export function acquireInstanceLock({ file = defaultLockPath(), label = "GX-ID" } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const data = {
    pid: process.pid,
    childPid: null,
    label,
    startedAt: new Date().toISOString(),
    cwd: process.cwd(),
    argv: process.argv.slice(1),
  };

  // Two passes: the first may find a stale (dead-pid) lock, which we remove and
  // then re-create. A live holder makes us give up immediately.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const existing = readLockInfo(file);
    if (existing?.alive) return { ok: false, holder: existing };

    if (existing) {
      // Stale lock (holder is gone) — reclaim it.
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* ignore */
      }
    }

    if (tryCreate(file, data)) {
      let released = false;
      const lock = {
        file,
        setChild(childPid) {
          if (released) return;
          const current = readRaw(file);
          // Someone else reclaimed the lock — never touch it again.
          if (!current || current.pid !== process.pid) return;
          try {
            overwrite(file, { ...current, childPid: childPid ?? null });
          } catch {
            /* ignore */
          }
        },
        release() {
          if (released) return;
          released = true;
          try {
            const current = readRaw(file);
            if (current && current.pid !== process.pid) return; // not ours
            fs.rmSync(file, { force: true });
          } catch {
            /* ignore */
          }
        },
      };
      return { ok: true, lock };
    }
    // EEXIST — a concurrent start won the race; loop once to re-check liveness.
  }

  return { ok: false, holder: readLockInfo(file) };
}
