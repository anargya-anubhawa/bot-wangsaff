/**
 * GX-ID — extended control command tests
 *
 * Exercises the control-ext handlers through the real ControlServer socket, using
 * a fake socket and an in-memory database so no WhatsApp connection is involved.
 */
import assert from "assert";
import net from "net";
import os from "os";
import path from "path";

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
  }
}

const { ControlServer } = await import("../lib/control-server.js");

/* ─────────────────────────────── fakes ─────────────────────────────── */

function fakeDb() {
  const settings = { regMode: "open", bulkDelayMin: 500 };
  const schedules = {};
  const stats = { commandsUsed: 42 };
  const state = { whitelistEnabled: false };
  const groups = { "111@g.us": { name: "Alpha", registered: true, antilink: true } };
  const notes = {};
  const filters = {};
  const blacklists = {};
  return {
    listRegistrations: () => [{ jid: "111@g.us", name: "Alpha", alias: "alpha", status: "active" }],
    getAllGroups: () => groups,
    getGroup: (jid) => groups[jid] || null,
    setGroup: (jid, data) => {
      groups[jid] = { ...(groups[jid] || {}), ...data, jid };
      return groups[jid];
    },
    listNotes: (scope) => Object.values(notes[scope] || {}),
    setNote: (scope, name, content) => {
      (notes[scope] ||= {})[name.toLowerCase()] = { name, content };
      return notes[scope][name.toLowerCase()];
    },
    deleteNote: (scope, name) => {
      const ok = Boolean(notes[scope]?.[name.toLowerCase()]);
      if (notes[scope]) delete notes[scope][name.toLowerCase()];
      return ok;
    },
    listFilters: (scope) => Object.values(filters[scope] || {}),
    setFilter: (scope, trigger, data) => {
      (filters[scope] ||= {})[trigger] = { trigger, ...data };
      return filters[scope][trigger];
    },
    deleteFilter: (scope, trigger) => {
      const ok = Boolean(filters[scope]?.[trigger]);
      if (filters[scope]) delete filters[scope][trigger];
      return ok;
    },
    listBlacklist: (scope) => Object.values(blacklists[scope] || {}),
    addBlacklist: (scope, entry) => {
      (blacklists[scope] ||= {})[entry] = { entry };
      return blacklists[scope][entry];
    },
    removeBlacklist: (scope, entry) => {
      const ok = Boolean(blacklists[scope]?.[entry]);
      if (blacklists[scope]) delete blacklists[scope][entry];
      return ok;
    },
    registerGroup: (jid, data) => ({ jid, ...data }),
    unregisterGroup: () => true,
    listRegistrationsFull: () => [],
    listFederations: () => [],
    listScopes: () => [],
    getSettings: () => ({ ...settings }),
    setting: (key, value = undefined) => {
      if (value !== undefined) settings[key] = value;
      return settings[key];
    },
    listWhitelist: () => [],
    addWhitelist: () => true,
    removeWhitelist: () => true,
    createSchedule: (id, data) => {
      schedules[id] = { id, active: true, ...data };
      return schedules[id];
    },
    listSchedules: () => Object.values(schedules),
    deleteSchedule: (id) => {
      const ok = Boolean(schedules[id]);
      delete schedules[id];
      return ok;
    },
    getTopCommands: (n) => [{ name: "menu", count: 10 }].slice(0, n),
    getTotalCommandUsage: () => 42,
    getCommandStatCount: () => 1,
    getStats: () => stats,
    eventLogCount: () => 0,
    _state: state,
  };
}

function fakeSock(calls) {
  return {
    sendText: async (jid, text) => {
      calls.push({ op: "text", jid, text });
      return { ok: true };
    },
    sendMedia: async (jid, source, caption, quoted, opts) => {
      calls.push({ op: "media", jid, caption, opts });
      return { ok: true };
    },
    sendPresenceUpdate: async (state, jid) => {
      calls.push({ op: "presence", state, jid });
    },
  };
}

let pathCounter = 0;
function uniquePath() {
  pathCounter += 1;
  if (process.platform === "win32") return `\\\\.\\pipe\\gx-id-ext-${process.pid}-${pathCounter}`;
  return path.join(os.tmpdir(), `gx-id-ext-${process.pid}-${pathCounter}.sock`);
}

async function makeServer(calls = []) {
  const db = fakeDb();
  const server = new ControlServer({
    path: uniquePath(),
    getSocket: () => fakeSock(calls),
    getDb: () => db,
    getUptime: () => 1_000,
    isConnected: () => true,
  });
  await server.start({});
  return server;
}

function rawRequest(server, request) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(server.path);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (message.id === request.id) {
          socket.end();
          resolve(message);
          return;
        }
      }
    });
    socket.on("error", reject);
  });
}

/* ─────────────────────────────── tests ─────────────────────────────── */

await test("settings-get returns sanitized settings", async () => {
  const server = await makeServer();
  const reply = await rawRequest(server, { id: 1, type: "settings-get" });
  assert.equal(reply.ok, true);
  assert.equal(reply.settings.regMode, "open");
  await server.stop();
});

await test("settings-set applies allowed keys and rejects ownerNumbers", async () => {
  const server = await makeServer();
  const ok = await rawRequest(server, { id: 2, type: "settings-set", settings: { bulkDelayMin: 900 } });
  assert.equal(ok.ok, true);
  assert.equal(ok.applied.bulkDelayMin, 900);
  const denied = await rawRequest(server, {
    id: 3, type: "settings-set", settings: { ownerNumbers: ["1"] },
  });
  assert.equal(denied.ok, false);
  await server.stop();
});

await test("owner-add / owner-list manage extra owners", async () => {
  const server = await makeServer();
  const added = await rawRequest(server, { id: 4, type: "owner-add", number: "6281234567890" });
  assert.equal(added.ok, true);
  assert.ok(added.owners.includes("6281234567890"));
  const list = await rawRequest(server, { id: 5, type: "owner-list" });
  assert.ok(list.owners.includes("6281234567890"));
  const removed = await rawRequest(server, { id: 6, type: "owner-remove", number: "6281234567890" });
  assert.ok(!removed.owners.includes("6281234567890"));
  await server.stop();
});

await test("schedule-add / list / delete round trip", async () => {
  const server = await makeServer();
  const added = await rawRequest(server, {
    id: 7, type: "schedule-add", jid: "111@g.us", content: "hi",
    sendTime: "08:00", recurrence: "daily",
  });
  assert.equal(added.ok, true);
  const id = added.schedule.id;
  const list = await rawRequest(server, { id: 8, type: "schedule-list" });
  assert.equal(list.schedules.length, 1);
  const del = await rawRequest(server, { id: 9, type: "schedule-delete", id });
  assert.equal(del.ok, true);
  await server.stop();
});

await test("schedule-add rejects bad time format", async () => {
  const server = await makeServer();
  const reply = await rawRequest(server, {
    id: 10, type: "schedule-add", jid: "111@g.us", content: "x", sendTime: "8am", recurrence: "daily",
  });
  assert.equal(reply.ok, false);
  await server.stop();
});

await test("media requires base64 or url", async () => {
  const server = await makeServer();
  const reply = await rawRequest(server, { id: 11, type: "media", jid: "111@g.us" });
  assert.equal(reply.ok, false);
  await server.stop();
});

await test("media base64 sends through the socket", async () => {
  const calls = [];
  const server = await makeServer(calls);
  const reply = await rawRequest(server, {
    id: 12, type: "media", jid: "111@g.us", base64: Buffer.from("hi").toString("base64"),
    mediaType: "image", caption: "test",
  });
  assert.equal(reply.ok, true);
  assert.equal(calls[0].op, "media");
  assert.equal(calls[0].caption, "test");
  await server.stop();
});

await test("presence rejects invalid state", async () => {
  const server = await makeServer();
  const reply = await rawRequest(server, { id: 13, type: "presence", state: "dancing" });
  assert.equal(reply.ok, false);
  await server.stop();
});

await test("stats returns top commands", async () => {
  const server = await makeServer();
  const reply = await rawRequest(server, { id: 14, type: "stats" });
  assert.equal(reply.ok, true);
  assert.equal(reply.stats.topCommands[0].name, "menu");
  await server.stop();
});

await test("unknown command still reports unknown", async () => {
  const server = await makeServer();
  const reply = await rawRequest(server, { id: 15, type: "definitely-not-a-command" });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /unknown request/);
  await server.stop();
});

await test("group-flags reads and group-set-flags updates", async () => {
  const server = await makeServer();
  const got = await rawRequest(server, { id: 20, type: "group-flags", jid: "111@g.us" });
  assert.equal(got.ok, true);
  assert.equal(got.flags.antilink, true);
  const set = await rawRequest(server, {
    id: 21, type: "group-set-flags", jid: "111@g.us", flags: { antilink: false, antinsfw: true },
  });
  assert.equal(set.ok, true);
  assert.equal(set.flags.antilink, false);
  assert.equal(set.flags.antinsfw, true);
  await server.stop();
});

await test("blacklist add / list / remove", async () => {
  const server = await makeServer();
  await rawRequest(server, { id: 22, type: "blacklist-add", jid: "111@g.us", entry: "badword" });
  const list = await rawRequest(server, { id: 23, type: "blacklist-list", jid: "111@g.us" });
  assert.equal(list.entries.length, 1);
  const del = await rawRequest(server, { id: 24, type: "blacklist-remove", jid: "111@g.us", entry: "badword" });
  assert.equal(del.ok, true);
  await server.stop();
});

await test("notes add / list / delete", async () => {
  const server = await makeServer();
  await rawRequest(server, { id: 25, type: "note-add", jid: "111@g.us", name: "rules", content: "be nice" });
  const list = await rawRequest(server, { id: 26, type: "note-list", jid: "111@g.us" });
  assert.equal(list.notes.length, 1);
  const del = await rawRequest(server, { id: 27, type: "note-delete", jid: "111@g.us", name: "rules" });
  assert.equal(del.ok, true);
  await server.stop();
});

await test("filters add / list / delete", async () => {
  const server = await makeServer();
  await rawRequest(server, { id: 28, type: "filter-add", jid: "111@g.us", trigger: "hi", content: "hello" });
  const list = await rawRequest(server, { id: 29, type: "filter-list", jid: "111@g.us" });
  assert.equal(list.filters.length, 1);
  const del = await rawRequest(server, { id: 30, type: "filter-delete", jid: "111@g.us", trigger: "hi" });
  assert.equal(del.ok, true);
  await server.stop();
});

await test("banned add / list / remove", async () => {
  const server = await makeServer();
  await rawRequest(server, { id: 31, type: "banned-add", number: "628111222333" });
  const list = await rawRequest(server, { id: 32, type: "banned-list" });
  assert.ok(list.banned.includes("628111222333"));
  const del = await rawRequest(server, { id: 33, type: "banned-remove", number: "628111222333" });
  assert.ok(!del.banned.includes("628111222333"));
  await server.stop();
});

await test("plugin-info reports categories", async () => {
  const server = await makeServer();
  const reply = await rawRequest(server, { id: 34, type: "plugin-info" });
  assert.equal(reply.ok, true);
  assert.ok(typeof reply.info.count === "number");
  await server.stop();
});

await test("reg-register registers a group", async () => {
  const server = await makeServer();
  const reply = await rawRequest(server, { id: 35, type: "reg-register", jid: "222@g.us", name: "Beta" });
  assert.equal(reply.ok, true);
  assert.equal(reply.registration.jid, "222@g.us");
  await server.stop();
});

await test("settings-options returns catalog with enums", async () => {
  const server = await makeServer();
  const reply = await rawRequest(server, { id: 40, type: "settings-options" });
  assert.equal(reply.ok, true);
  assert.equal(reply.catalog.botMode.type, "enum");
  assert.ok(reply.catalog.botMode.options.includes("reggroup"));
  await server.stop();
});

await test("env-list masks secret values", async () => {
  const server = await makeServer();
  const reply = await rawRequest(server, { id: 41, type: "env-list" });
  assert.equal(reply.ok, true);
  assert.ok(Array.isArray(reply.entries));
  const secret = reply.entries.find((e) => e.secret && e.set);
  // any present secret must be masked, never the raw value
  if (secret) assert.equal(secret.value, "********");
  await server.stop();
});

/* ─────────────────────────────── report ─────────────────────────────── */

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.ok ? "" : `: ${r.error}`}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
