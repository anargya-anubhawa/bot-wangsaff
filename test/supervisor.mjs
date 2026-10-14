/**
 * GX-ID — supervisor / single-instance lock / runtime-mode test
 *
 * Verifies the mechanism that fixes "the bot looks stopped but is actually
 * running in the background":
 *
 *   • the single-instance lock refuses a second bot and reclaims stale locks;
 *   • runtime-mode detection picks the right lifecycle owner;
 *   • the built-in supervisor restarts the worker IN PLACE (no detach) on the
 *     restart exit code, and exits cleanly when the worker stops on its own.
 */
import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const fileUrl = (p) => pathToFileURL(p).href;

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gx-sup-test-"));

/* ─────────────────────────── instance lock ─────────────────────────── */

const lockMod = await import("../lib/instance-lock.js");

await test("acquireInstanceLock succeeds and blocks a second holder", () => {
  const file = path.join(tmp, "a.lock");
  const first = lockMod.acquireInstanceLock({ file });
  assert.equal(first.ok, true, "first acquire should succeed");

  const second = lockMod.acquireInstanceLock({ file });
  assert.equal(second.ok, false, "second acquire must be refused");
  assert.equal(second.holder.alive, true);
  assert.equal(second.holder.pid, process.pid);

  first.lock.release();
  const third = lockMod.acquireInstanceLock({ file });
  assert.equal(third.ok, true, "acquire after release should succeed");
  third.lock.release();
});

await test("a stale lock (dead pid) is reclaimed automatically", () => {
  const file = path.join(tmp, "stale.lock");
  fs.writeFileSync(
    file,
    JSON.stringify({ pid: 999999, childPid: null, label: "ghost", startedAt: null }),
  );
  const info = lockMod.readLockInfo(file);
  assert.equal(info.alive, false, "dead pid must read as not alive");

  const acquired = lockMod.acquireInstanceLock({ file });
  assert.equal(acquired.ok, true, "stale lock must be reclaimable");
  acquired.lock.release();
});

await test("setChild records the worker pid and release removes the file", () => {
  const file = path.join(tmp, "child.lock");
  const { ok, lock } = lockMod.acquireInstanceLock({ file });
  assert.equal(ok, true);
  lock.setChild(4242);
  const info = lockMod.readLockInfo(file);
  assert.equal(info.childPid, 4242);
  assert.equal(info.childAlive, false, "4242 is not a live pid here");
  lock.release();
  assert.equal(fs.existsSync(file), false, "lock file must be gone after release");
});

await test("isProcessAlive reflects the current process", () => {
  assert.equal(lockMod.isProcessAlive(process.pid), true);
  assert.equal(lockMod.isProcessAlive(999999), false);
  assert.equal(lockMod.isProcessAlive(0), false);
});

/* ─────────────────────────── runtime mode ─────────────────────────── */

const mode = await import("../lib/runtime-mode.js");

await test("shouldSupervise defaults on, and stands down for watch/supervisors", () => {
  const saved = { ...process.env };
  try {
    for (const k of ["GX_SUPERVISED", "GX_SUPERVISE", "pm_id", "PM2_HOME", "INVOCATION_ID", "KUBERNETES_SERVICE_HOST", "container"]) {
      delete process.env[k];
    }
    assert.equal(mode.shouldSupervise(), true, "default should supervise");

    process.env.GX_SUPERVISE = "0";
    assert.equal(mode.shouldSupervise(), false, "GX_SUPERVISE=0 disables");
    delete process.env.GX_SUPERVISE;

    process.env.pm_id = "0";
    assert.equal(mode.detectSupervisor(), "pm2");
    assert.equal(mode.shouldSupervise(), false, "pm2 disables the built-in supervisor");
    delete process.env.pm_id;

    process.env.INVOCATION_ID = "abc";
    assert.equal(mode.detectSupervisor(), "systemd");
    delete process.env.INVOCATION_ID;

    process.env.GX_SUPERVISE = "1";
    process.env.pm_id = "0";
    assert.equal(mode.shouldSupervise(), true, "GX_SUPERVISE=1 forces it on");
    delete process.env.GX_SUPERVISE;
    delete process.env.pm_id;
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

await test("isSupervisedWorker / restartStrategyLabel", () => {
  assert.equal(mode.isSupervisedWorker(), false);
  assert.equal(typeof mode.restartStrategyLabel(), "string");
  assert.equal(mode.RESTART_EXIT_CODE, 75);
});

/* ─────────────────────────── supervisor (integration) ─────────────────────────── */

// A worker that bumps a counter file and exits with a configurable code. It
// exits with `midCode` until it reaches `target`, then exits with `finalCode` —
// so we can simulate both an explicit restart (code 75) and a crash (code 1).
const workerPath = path.join(tmp, "worker.mjs");
const counterPath = path.join(tmp, "count.txt");
fs.writeFileSync(
  workerPath,
  `
import fs from "fs";
const [counter, target, midCode, finalCode] = process.argv.slice(2);
let n = 0;
try { n = Number(fs.readFileSync(counter, "utf8")) || 0; } catch {}
n += 1;
fs.writeFileSync(counter, String(n));
process.exit(n >= Number(target) ? Number(finalCode) : Number(midCode));
`,
);

/** Write a driver that runs the real supervisor around the worker. */
function writeDriver(name, args) {
  const driver = path.join(tmp, name);
  fs.writeFileSync(
    driver,
    `
import { runSupervisor } from ${JSON.stringify(fileUrl(path.join(root, "lib", "supervisor.js")))};
const lockCalls = [];
const lock = { setChild: (pid) => lockCalls.push(pid), release: () => lockCalls.push("release") };
runSupervisor({
  lock,
  argv: [${JSON.stringify(workerPath)}, ...${JSON.stringify(args)}],
  cwd: ${JSON.stringify(tmp)},
});
`,
  );
  return driver;
}

function runDriver(driver) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [driver], { cwd: tmp, stdio: "ignore" });
    child.on("exit", (c) => resolve(c));
  });
}

await test("supervisor restarts the worker in place until it stops cleanly", async () => {
  fs.rmSync(counterPath, { force: true });
  const driver = writeDriver("driver-restart.mjs", [counterPath, "3", "75", "0"]);
  const code = await runDriver(driver);
  assert.equal(code, 0, "supervisor should exit 0 after the worker stops cleanly");
  assert.equal(fs.readFileSync(counterPath, "utf8"), "3", "worker should have run 3 times");
});

await test("supervisor restarts a CRASHED worker with backoff, then exits on clean stop", async () => {
  fs.rmSync(counterPath, { force: true });
  // crash twice (exit 1) with backoff, then stop cleanly on the 3rd run.
  const driver = writeDriver("driver-crash.mjs", [counterPath, "3", "1", "0"]);
  const code = await runDriver(driver);
  assert.equal(code, 0, "supervisor should exit 0 once the worker stops cleanly");
  assert.equal(fs.readFileSync(counterPath, "utf8"), "3", "crashed worker must be restarted");
});

await test("supervisor keeps restarting a long-running worker that requests restarts", async () => {
  fs.rmSync(counterPath, { force: true });
  // A worker that never stops on its own (exit code 75 forever).
  const driver = writeDriver("driver-hang.mjs", [counterPath, "999999", "75", "0"]);
  const child = spawn(process.execPath, [driver], { cwd: tmp, stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 2500)); // let a couple of cycles run
  const runs = Number(fs.readFileSync(counterPath, "utf8")) || 0;
  child.kill("SIGKILL");
  await new Promise((resolve) => child.on("exit", resolve));
  assert.ok(runs >= 2, `worker should have restarted at least twice (got ${runs})`);
});

// Windows cannot deliver a catchable SIGTERM to a spawned child (Node uses
// TerminateProcess), so the clean-shutdown-on-signal behaviour is only
// assertable on POSIX — which is exactly where the VPS runs.
if (process.platform === "win32") {
  results.push({ name: "supervisor shuts the worker down on SIGTERM (skipped on Windows)", ok: true });
} else {
  await test("supervisor shuts the worker down on SIGTERM", async () => {
    fs.rmSync(counterPath, { force: true });
    const driver = writeDriver("driver-term.mjs", [counterPath, "999999", "75", "0"]);
    const child = spawn(process.execPath, [driver], { cwd: tmp, stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 2000));
    child.kill("SIGTERM");
    const code = await new Promise((resolve) => child.on("exit", (c) => resolve(c)));
    assert.equal(code, 0, "supervisor should exit 0 on SIGTERM");
  });
}

fs.rmSync(tmp, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "✓" : "✗"} ${r.name}${r.ok ? "" : ` — ${r.error}`}`);
console.log(`\n${results.length - failed.length}/${results.length} supervisor checks passed`);
process.exit(failed.length ? 1 : 0);
