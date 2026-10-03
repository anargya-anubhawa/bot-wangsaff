/**
 * GX-ID — Altheora + Native Flow acceptance tests
 *
 * Drives real messages through the full pipeline (serialize → messageHandler)
 * against a mock socket, then mutates the `assets/altheora` tree on disk to
 * prove that the menu is fully dynamic.
 *
 * Covered:
 *   1. category flow (multi single_select, one per category)
 *   2. new folder appears
 *   3. new file appears
 *   4. selecting a file sends it as a document (no navigation messages)
 *   5. deleted file disappears / missing file is safe
 *   6. empty folder is not listed
 *   7. two-user isolation
 *   8. path traversal is rejected
 *   9. unsupported file is refused
 *  10. flow id router dispatch (altheora:file:…)
 *  11. pagination (MAX_FLOW_ROWS)
 *  12. legacy text sub-command still works
 */
import assert from "assert";
import fs from "fs";
import path from "path";

const ROOT = path.resolve(process.cwd(), "assets", "altheora");

const dbPath = path.join(process.cwd(), "database", "altheora-test");
fs.rmSync(dbPath, { recursive: true, force: true });

const { initDatabase } = await import("../lib/database.js");
await initDatabase(dbPath);

const { loadPlugins } = await import("../lib/plugins.js");
await loadPlugins(path.join(process.cwd(), "plugins"));

const { messageHandler } = await import("../core/message.js");
const { extendSocket } = await import("../lib/socket.js");
const { MAX_FLOW_ROWS } = await import("../lib/flow.js");
const { invalidateRegistry } = await import("../plugins/altheora/_registry.js");

/* ─────────────────────────── sandbox fixtures ─────────────────────────── */

const TMP = ["ZZTEST ALPHA", "ZZTEST BETA", "ZZTEST EMPTY", "ZZTEST GAMMA"];

function rmTmp() {
  for (const name of TMP) fs.rmSync(path.join(ROOT, name), { recursive: true, force: true });
  invalidateRegistry();
}

function resetSandbox() {
  rmTmp();
  fs.mkdirSync(path.join(ROOT, "ZZTEST ALPHA"), { recursive: true });
  fs.mkdirSync(path.join(ROOT, "ZZTEST BETA", "SUB"), { recursive: true });
  fs.mkdirSync(path.join(ROOT, "ZZTEST EMPTY"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "ZZTEST ALPHA", "Doc One 2026.pdf"), Buffer.from("%PDF-1.4 alpha"));
  fs.writeFileSync(path.join(ROOT, "ZZTEST BETA", "Sub Doc.pdf"), Buffer.from("%PDF-1.4 beta"));
  fs.writeFileSync(path.join(ROOT, "ZZTEST BETA", "SUB", "Nested Doc.pdf"), Buffer.from("%PDF-1.4 nested"));
  fs.writeFileSync(path.join(ROOT, "ZZTEST BETA", "Notes.txt"), Buffer.from("hello"));
  invalidateRegistry();
}

resetSandbox();

/* ─────────────────────────── mock socket ─────────────────────────── */

function makeSock() {
  const sent = [];
  const sock = {
    user: { id: "628999:1@s.whatsapp.net", name: "GX-ID" },
    sendMessage: async (jid, content, options) => {
      sent.push({ jid, content, options });
      return { key: { id: `m${sent.length}` } };
    },
    relayMessage: async (jid, message, options) => {
      sent.push({ jid, relayed: message, options });
      return { key: { id: `r${sent.length}` } };
    },
    groupMetadata: async () => ({ subject: "T", participants: [], announce: false }),
    sendPresenceUpdate: async () => {},
    profilePictureUrl: async () => null,
    waUploadToServer: {},
    store: { contacts: {} },
    updateMediaMessage: async () => {},
  };
  extendSocket(sock);
  sock.prepareMedia = async () => ({ imageMessage: { url: "https://example.com/x.jpg" } });
  return { sock, sent };
}

function rawMsg(body, { group = false, sender = null } = {}) {
  const from = sender || currentSender();
  return {
    key: {
      remoteJid: group ? "1234@g.us" : from,
      fromMe: false,
      id: `MSG${Math.random().toString(36).slice(2)}`,
      participant: group ? from : undefined,
    },
    message: { conversation: body },
    messageTimestamp: Math.floor(Date.now() / 1000),
    pushName: "Tester",
  };
}

/** Build a native-flow interactive response (row id carried in paramsJson). */
function rawInteractive(id, { group = false, sender = null } = {}) {
  const from = sender || currentSender();
  return {
    key: {
      remoteJid: group ? "1234@g.us" : from,
      fromMe: false,
      id: `MSG${Math.random().toString(36).slice(2)}`,
      participant: group ? from : undefined,
    },
    message: {
      messageContextInfo: {},
      interactiveResponseMessage: {
        nativeFlowResponseMessage: { name: "single_select", paramsJson: JSON.stringify({ id }) },
      },
    },
    messageTimestamp: Math.floor(Date.now() / 1000),
    pushName: "Tester",
  };
}

const CATKEY = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

function interactiveButtons(sent) {
  const relayed = sent.find((s) => s.relayed);
  return relayed?.relayed?.viewOnceMessage?.message?.interactiveMessage?.nativeFlowMessage?.buttons || [];
}
function interactiveBody(sent) {
  const relayed = sent.find((s) => s.relayed);
  return relayed?.relayed?.viewOnceMessage?.message?.interactiveMessage?.body?.text || "";
}
function allRows(sent) {
  const out = [];
  for (const b of interactiveButtons(sent)) {
    if (b.name !== "single_select") continue;
    const p = JSON.parse(b.buttonParamsJson);
    for (const sec of p.sections || []) for (const r of sec.rows || []) out.push(r);
  }
  return out;
}
function allRowsBySection(sent) {
  const map = {};
  for (const b of interactiveButtons(sent)) {
    if (b.name !== "single_select") continue;
    const p = JSON.parse(b.buttonParamsJson);
    if (!p.sections) continue;
    for (const sec of p.sections) map[sec.title] = sec.rows || [];
  }
  return map;
}
/** Selector button titles (one per category). */
function selectorTitles(sent) {
  const out = [];
  for (const b of interactiveButtons(sent)) {
    if (b.name !== "single_select") continue;
    const p = JSON.parse(b.buttonParamsJson);
    if (p.title) out.push(p.title);
  }
  return out;
}
function anyText(sent) {
  return sent.map((s) => s.content?.text || s.content?.caption || "").join("\n");
}

const results = [];
let senderSeq = 100000;
function currentSender() {
  return `62811${senderSeq}@s.whatsapp.net`;
}
async function test(name, fn) {
  senderSeq++; // fresh sender per test → avoids the core anti-spam gate (8/5s)
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
  }
}

/* ─────────────────────────── tests ─────────────────────────── */

/* 1. category flow (multi single_select) */
await test("1. .altheora renders a multi-selector native flow", async () => {
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".altheora"), sock);
  const buttons = interactiveButtons(sent);
  const selectors = buttons.filter((b) => b.name === "single_select");
  assert.ok(selectors.length >= 3, `expected multiple selectors, got ${selectors.length}`);
  // reference pattern: leading has_multiple_buttons marker
  const marker = selectors.find((b) => JSON.parse(b.buttonParamsJson).has_multiple_buttons);
  assert.ok(marker, "missing has_multiple_buttons marker");
  const titles = selectorTitles(sent).join(" | ");
  assert.ok(titles.includes("ZZTEST ALPHA"), `ALPHA category missing: ${titles}`);
  assert.ok(titles.includes("SOP"), `SOP category missing: ${titles}`);
  assert.ok(interactiveBody(sent).includes("Altheora") || interactiveBody(sent).length > 0, "empty body");
});

/* 1b. flow rows carry namespaced ids */
await test("1b. flow row ids are namespaced (altheora:file:…)", async () => {
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".altheora"), sock);
  const row = allRows(sent).find((r) => r.title.includes("Doc One 2026"));
  assert.ok(row, "file row missing");
  assert.ok(/^altheora:file:/.test(row.id), `id not namespaced: ${row.id}`);
  assert.ok(!row.id.includes("/") && !row.id.includes("\\"), `id must not contain a path: ${row.id}`);
  assert.ok(!row.id.includes(".."), `id must not contain traversal: ${row.id}`);
});

/* 2. flow id router dispatch sends the document */
await test("2. tapping a flow row sends the document (router)", async () => {
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".altheora"), sock);
  const row = allRows(sent).find((r) => r.title.includes("Doc One 2026"));
  assert.ok(row, "file row missing");

  const { sock: sock2, sent: sent2 } = makeSock();
  await messageHandler(rawInteractive(row.id), sock2);
  const doc = sent2.find((s) => s.content?.document);
  assert.ok(doc, "no document sent after selecting the flow row");
  assert.equal(doc.content.fileName, "Doc One 2026.pdf", `filename mismatch: ${doc.content.fileName}`);
  assert.equal(doc.content.mimetype, "application/pdf", "mimetype mismatch");
  assert.ok(Buffer.isBuffer(doc.content.document), "document is not a Buffer");
});

/* 3. new folder appears */
await test("3. new folder appears without restart", async () => {
  fs.mkdirSync(path.join(ROOT, "ZZTEST GAMMA"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "ZZTEST GAMMA", "G Doc.pdf"), Buffer.from("%PDF gamma"));
  invalidateRegistry();
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".altheora"), sock);
  const titles = selectorTitles(sent).join(" | ");
  assert.ok(titles.includes("ZZTEST GAMMA"), `GAMMA category missing: ${titles}`);
});

/* 4. new file appears */
await test("4. new file appears without restart", async () => {
  fs.writeFileSync(path.join(ROOT, "ZZTEST ALPHA", "Fresh File.pdf"), Buffer.from("%PDF fresh"));
  invalidateRegistry();
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".altheora"), sock);
  const titles = allRows(sent).map((r) => r.title).join(" | ");
  assert.ok(titles.includes("Fresh File"), `Fresh File missing: ${titles}`);
});

/* 4b. nested subfolder files are flattened into the category selector */
await test("4b. nested subfolder file is listed in the category flow", async () => {
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".altheora"), sock);
  const titles = allRows(sent).map((r) => r.title).join(" | ");
  assert.ok(titles.includes("Nested Doc"), `nested file missing: ${titles}`);
});

/* 5. deleted file disappears + missing file is safe */
await test("5. deleted file disappears and fetch is safe", async () => {
  const p = path.join(ROOT, "ZZTEST ALPHA", "Fresh File.pdf");
  fs.rmSync(p, { force: true });
  invalidateRegistry();
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".altheora"), sock);
  const titles = allRows(sent).map((r) => r.title).join(" | ");
  assert.ok(!titles.includes("Fresh File"), `Fresh File still listed: ${titles}`);

  const { sock: sock2, sent: sent2 } = makeSock();
  await messageHandler(rawInteractive(`altheora:file:${CATKEY("ZZTEST ALPHA")}:fresh-file`), sock2);
  const txt = anyText(sent2);
  assert.ok(/tidak tersedia|tidak ditemukan/i.test(txt), `expected not-found message, got: ${txt}`);
  assert.ok(!sent2.some((s) => s.content?.document), "must not send a missing document");
});

/* 6. empty folder is not listed */
await test("6. empty folder is not listed", async () => {
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".altheora"), sock);
  const titles = selectorTitles(sent).join(" | ");
  assert.ok(!titles.includes("ZZTEST EMPTY"), `empty folder should be hidden: ${titles}`);
});

/* 7. two-user isolation */
await test("7. two-user isolation (group chat)", async () => {
  const userA = "628111111111@s.whatsapp.net";
  const userB = "628222222222@s.whatsapp.net";

  const { sock: sockA, sent: sentA } = makeSock();
  await messageHandler(rawMsg(".altheora", { group: true, sender: userA }), sockA);
  const rowA = allRows(sentA).find((r) => r.title.includes("Doc One 2026"));

  const { sock: sockB, sent: sentB } = makeSock();
  await messageHandler(rawMsg(".altheora", { group: true, sender: userB }), sockB);
  const rowB = allRows(sentB).find((r) => r.title.includes("Sub Doc"));
  assert.ok(rowA && rowB, "rows missing");
  assert.notEqual(rowA.id, rowB.id, "ids should differ");

  const { sock: sockA2, sent: sentA2 } = makeSock();
  await messageHandler(rawInteractive(rowA.id, { group: true, sender: userA }), sockA2);
  const docA = sentA2.find((s) => s.content?.document);
  assert.ok(docA, "A got no document");
  assert.equal(docA.content.fileName, "Doc One 2026.pdf", `A got wrong file: ${docA.content.fileName}`);
  assert.equal(docA.jid, "1234@g.us", "A doc sent to wrong chat");

  const { sock: sockB2, sent: sentB2 } = makeSock();
  await messageHandler(rawInteractive(rowB.id, { group: true, sender: userB }), sockB2);
  const docB = sentB2.find((s) => s.content?.document);
  assert.ok(docB, "B got no document");
  assert.equal(docB.content.fileName, "Sub Doc.pdf", `B got wrong file: ${docB.content.fileName}`);
});

/* 8. path traversal is rejected */
await test("8. path traversal rejected", async () => {
  const { sock, sent } = makeSock();
  await messageHandler(rawInteractive(`altheora:file:${CATKEY("ZZTEST ALPHA")}:..%2F..%2Fconfig.js`), sock);
  const txt = anyText(sent);
  assert.ok(/tidak tersedia|tidak ditemukan|ditolak/i.test(txt), `expected rejection, got: ${txt}`);
  assert.ok(!sent.some((s) => s.content?.document), "must not send any document");
});

/* 9. unsupported file type is refused cleanly */
await test("9. unsupported file refused", async () => {
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".altheora"), sock);
  const row = allRows(sent).find((r) => r.title.includes("Notes"));
  assert.ok(row, "txt row missing");
  const { sock: sock2, sent: sent2 } = makeSock();
  await messageHandler(rawInteractive(row.id), sock2);
  assert.ok(!sent2.some((s) => s.content?.document), "should not send unsupported file");
});

/* 10. legacy text sub-commands still work */
await test("10. legacy .altheora dir still works", async () => {
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(`.altheora dir ${CATKEY("ZZTEST ALPHA")} -`), sock);
  const txt = anyText(sent);
  assert.ok(txt.includes("Doc One 2026"), `legacy dir listing missing file: ${txt}`);
});

/* 11. pagination constant is honoured */
await test("11. MAX_FLOW_ROWS paginates large categories", async () => {
  const many = path.join(ROOT, "ZZTEST ALPHA");
  const created = [];
  for (let i = 0; i < MAX_FLOW_ROWS + 3; i++) {
    const f = path.join(many, `Bulk ${String(i).padStart(2, "0")}.pdf`);
    fs.writeFileSync(f, Buffer.from("%PDF bulk"));
    created.push(f);
  }
  invalidateRegistry();
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".altheora"), sock);
  const sections = allRowsBySection(sent);
  const alphaRows = Object.values(sections).flat().filter((r) => /Bulk|Doc One/.test(r.title));
  assert.ok(alphaRows.length <= MAX_FLOW_ROWS, `section exceeded MAX_FLOW_ROWS: ${alphaRows.length}`);
  const hasNext = Object.values(sections).flat().some((r) => /Selanjutnya/.test(r.title));
  assert.ok(hasNext, "expected a 'Selanjutnya' pagination row");
  for (const f of created) fs.rmSync(f, { force: true });
  invalidateRegistry();
});

/* 12. .menu renders the usual single-selector menu and hides owner category */
await test("12. .menu renders single-selector menu and hides owner category for users", async () => {
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".menu"), sock);
  const selectors = interactiveButtons(sent).filter((b) => b.name === "single_select");
  assert.equal(selectors.length, 1, `expected a single selector, got ${selectors.length}`);
  const titles = allRows(sent).map((r) => r.title).join(" | ");
  assert.ok(titles.includes("ALTHEORA"), `altheora category missing: ${titles}`);
  assert.ok(!titles.includes("OWNER"), `owner category leaked to a normal user: ${titles}`);
});

/* report */
const failed = results.filter((r) => !r.ok);
const report = { passed: results.length - failed.length, total: results.length, results };
fs.writeFileSync(path.join(process.cwd(), "altheora-report.json"), JSON.stringify(report, null, 2));

rmTmp();
fs.rmSync(dbPath, { recursive: true, force: true });
for (const r of results) console.log(`${r.ok ? "✓" : "✗"} ${r.name}${r.ok ? "" : ` — ${r.error}`}`);
console.log(`\n${results.length - failed.length}/${results.length} altheora checks passed`);
process.exit(failed.length ? 1 : 0);
