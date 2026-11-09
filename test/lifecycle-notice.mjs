/**
 * GX-ID — lifecycle notices (bot aktif / shutting down)
 *
 * The bot announces itself on the owner's MANAGEMENT PANEL — the global default
 * log panel (`.log default`) — when it becomes ready and when it stops.
 *
 * Run with: node test/lifecycle-notice.mjs
 */
import assert from "assert";
import path from "path";
import fs from "fs";

const dbPath = path.join(process.cwd(), "database", "lifecycle-test");
fs.rmSync(dbPath, { recursive: true, force: true });

const { initDatabase, getDatabase } = await import("../lib/database.js");
await initDatabase(dbPath);
const db = getDatabase();

const { setDefaultLogPanel } = await import("../lib/settings.js");
const lc = await import("../lib/lifecycle-notice.js");
const config = (await import("../config.js")).default;

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
  }
}

/** A socket that records what is sent where. */
function makeSock() {
  const sent = [];
  return {
    sent,
    sendMessage: async (jid, content) => {
      sent.push({ jid, content });
      return { key: { id: `m${sent.length}` } };
    },
  };
}

function reset() {
  setDefaultLogPanel(null);
}

const PANEL = "120363000000000001@g.us";

/* ═══════════════════════════ panel resolution ═══════════════════════════ */

await test("no default panel configured → notices are a silent no-op", async () => {
  reset();
  assert.equal(lc.getManagementPanel(), null);
  const sock = makeSock();
  assert.equal(await lc.notifyOnline(sock), false);
  assert.equal(await lc.notifyShutdown({ reason: "SIGTERM" }), false);
  assert.deepEqual(sock.sent, [], "nothing may be sent without a panel");
});

await test("the global default log panel is the management panel", async () => {
  reset();
  setDefaultLogPanel(PANEL);
  assert.equal(lc.getManagementPanel(), PANEL);
  reset();
});

await test("a per-group logPanel does NOT receive lifecycle notices", async () => {
  reset();
  // A group registration with its own panel must not be targeted.
  db.registerGroup("120363000000000009@g.us", { alias: "lapangan" });
  db.setRegistrationLogPanel("120363000000000009@g.us", "120363000000000009@g.us");
  const sock = makeSock();
  assert.equal(await lc.notifyOnline(sock), false, "only the global default panel is used");
  assert.deepEqual(sock.sent, []);
  reset();
});

/* ═══════════════════════════ online ═══════════════════════════ */

await test("online: one notice to the panel, saying the bot is active", async () => {
  reset();
  setDefaultLogPanel(PANEL);
  const sock = makeSock();
  assert.equal(await lc.notifyOnline(sock), true);
  assert.equal(sock.sent.length, 1);
  assert.equal(sock.sent[0].jid, PANEL);
  const text = sock.sent[0].content.text;
  assert.match(text, /BOT AKTIF/i, `got: ${text}`);
  assert.match(text, /Online/, `got: ${text}`);
  assert.ok(text.includes(config.bot?.name || "GX-ID"), "the bot name must be shown");
  reset();
});

/* ═══════════════════════════ shutdown ═══════════════════════════ */

await test("shutdown: one notice to the panel, saying shutting down", async () => {
  reset();
  setDefaultLogPanel(PANEL);
  const sock = makeSock();
  assert.equal(await lc.notifyShutdown({ reason: "SIGTERM", uptimeMs: 3_720_000 }, sock), true);
  assert.equal(sock.sent.length, 1);
  assert.equal(sock.sent[0].jid, PANEL);
  const text = sock.sent[0].content.text;
  assert.match(text, /SHUTTING DOWN/i, `got: ${text}`);
  assert.match(text, /SIGTERM/, "the reason must be shown");
  assert.match(text, /1h 2m/, `uptime must be rendered, got: ${text}`);
  reset();
});

await test("shutdown: a restart says the bot will come back", async () => {
  reset();
  setDefaultLogPanel(PANEL);
  const sock = makeSock();
  await lc.notifyShutdown({ reason: "restart", restart: true }, sock);
  const text = sock.sent[0].content.text;
  assert.match(text, /kembali/i, `got: ${text}`);
  reset();
});

await test("shutdown: a permanent stop does not promise a comeback", async () => {
  reset();
  setDefaultLogPanel(PANEL);
  const sock = makeSock();
  await lc.notifyShutdown({ reason: "SIGINT", restart: false }, sock);
  const text = sock.sent[0].content.text;
  assert.doesNotMatch(text, /kembali/i, `got: ${text}`);
  reset();
});

/* ═══════════════════════════ resilience ═══════════════════════════ */

await test("a sending failure never throws (a shutdown must not be blocked)", async () => {
  reset();
  setDefaultLogPanel(PANEL);
  const sock = {
    sendMessage: async () => {
      throw new Error("network down");
    },
  };
  assert.equal(await lc.notifyOnline(sock), false);
  reset();
});

await test("buildLifecycleNotice renders both kinds", () => {
  assert.match(lc.buildLifecycleNotice("online"), /BOT AKTIF/);
  assert.match(lc.buildLifecycleNotice("shutdown"), /SHUTTING DOWN/);
});

await test("uptime labels are human readable", () => {
  assert.match(lc.buildLifecycleNotice("shutdown", { uptimeMs: 45_000 }), /45s/);
  assert.match(lc.buildLifecycleNotice("shutdown", { uptimeMs: 90_000 }), /1m/);
  assert.match(lc.buildLifecycleNotice("shutdown", { uptimeMs: 7_200_000 }), /2h 0m/);
  assert.match(lc.buildLifecycleNotice("shutdown", { uptimeMs: 90_000_000 }), /1d 1h/);
});

/* ─────────────────────────── report ─────────────────────────── */

reset();
for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name}${r.ok ? "" : ` — ${r.error}`}`);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} lifecycle checks passed`);
fs.rmSync(dbPath, { recursive: true, force: true });
if (failed.length) process.exit(1);
process.exit(0);
