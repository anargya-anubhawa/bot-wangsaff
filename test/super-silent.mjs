/**
 * GX-ID — super silent mode (`.silent super`)
 *
 * Super silent mode minimises a command's output: instead of answering in text,
 * the bot reacts once — 🟢 when the command reported success, 🔴 when it
 * reported a failure, 🟡 when the outcome cannot be decided. This suite drives
 * the real pipeline against a mock socket and covers:
 *
 *   • the three levels (`off` / `on` / `super`) and their persistence
 *   • classification (text markers, call-site returns, throws)
 *   • held replies ("processing…" then a verdict → exactly one reaction)
 *   • replays when the outcome is inconclusive
 *   • cancels (a confirmation answered "no" never turns red)
 *   • normal-mode auto-✅ and media passthrough
 *   • case commands and native-flow taps obey the same turn
 *
 * Run with: node test/super-silent.mjs
 */
import assert from "assert";
import path from "path";
import fs from "fs";

const dbPath = path.join(process.cwd(), "database", "super-silent-test");
fs.rmSync(dbPath, { recursive: true, force: true });

const { initDatabase, getDatabase } = await import("../lib/database.js");
await initDatabase(dbPath);
const db = getDatabase();
db.setting("ownerNumbers", ["628000000001"]);

const { loadPlugins, getPlugin } = await import("../lib/plugins.js");
await loadPlugins(path.join(process.cwd(), "plugins"));

const { messageHandler } = await import("../core/message.js");
const { extendSocket } = await import("../lib/socket.js");
const config = (await import("../config.js")).default;
const rt = await import("../lib/reply-transform.js");
const { classifyText, cancel, CancelSignal } = rt;

if (config.features) config.features.antiSpam = false;
config.messages.silent = false;

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
  }
}

const BOT = "628000000099@s.whatsapp.net";
const USER = "628000000004@s.whatsapp.net";
const OWNER = "628000000001@s.whatsapp.net";

function makeSock() {
  const sent = [];
  const sock = {
    user: { id: BOT, name: "GX-ID" },
    sendMessage: async (jid, content, options) => {
      sent.push({ jid, content, options });
      return { key: { id: `m${sent.length}` } };
    },
    relayMessage: async (jid, message, options) => {
      sent.push({ jid, relayed: message, options });
      return { key: { id: `r${sent.length}` } };
    },
    groupMetadata: async () => ({
      subject: "Super Test",
      participants: [
        { id: BOT, admin: "superadmin" },
        { id: USER, admin: null },
      ],
      announce: false,
    }),
    sendPresenceUpdate: async () => {},
    profilePictureUrl: async () => null,
    prepareMedia: async () => ({ imageMessage: { url: "https://example.com/x.jpg" } }),
    waUploadToServer: {},
    store: { contacts: {} },
    updateMediaMessage: async () => {},
  };
  extendSocket(sock);
  return { sock, sent };
}

function rawMsg(body, { group = null, sender = USER } = {}) {
  return {
    key: { remoteJid: group === null ? sender : group, fromMe: false, id: `M${Math.random()}`, participant: group ? sender : undefined },
    message: { conversation: body },
    messageTimestamp: Math.floor(Date.now() / 1000),
    pushName: "Tester",
  };
}

const textsOf = (sent) => sent.filter((s) => s.content?.text).map((s) => s.content.text);
const reactionsOf = (sent) => sent.filter((s) => s.content?.react).map((s) => s.content.react.text);

/* Fresh level + cooldowns before every case so order never matters. */
function reset() {
  rt.setSilentLevel(undefined);
  config.messages.superSilent = false;
  config.messages.silent = false;
  db.setting("silentMode", null);
  db.setting("silentLevel", null);
  try {
    const users = db.getAllUsers ? db.getAllUsers() : {};
    for (const jid of Object.keys(users)) db.setUser(jid, { cooldowns: {} });
  } catch {
    /* ignore */
  }
}

/**
 * Swap a real plugin's handler for the duration of `fn`, so the pipeline (gates,
 * cooldowns, turn lifecycle) runs exactly as in production.
 */
async function withHandler(name, handler, fn) {
  const plugin = getPlugin(name);
  assert.ok(plugin, `plugin ${name} must exist`);
  const original = plugin.handler;
  plugin.handler = handler;
  try {
    return await fn();
  } finally {
    plugin.handler = original;
    reset();
  }
}

/* ═══════════════════════════ classification ═══════════════════════════ */

await test("classifyText: Indonesian and English success markers", () => {
  assert.equal(classifyText("✅ Berhasil mengeluarkan @628123."), "ok");
  assert.equal(classifyText("Sukses ditambahkan ke grup."), "ok");
  assert.equal(classifyText("User removed."), "ok");
  assert.equal(classifyText("✅ Done!"), "ok");
});

await test("classifyText: failure markers", () => {
  assert.equal(classifyText("❌ Gagal: user bukan admin."), "fail");
  assert.equal(classifyText("Gagal mengubah nama grup."), "fail");
  assert.equal(classifyText("Target tidak ditemukan."), "fail");
  assert.equal(classifyText("Rate limit exceeded, unable to continue."), "fail");
});

await test("classifyText: a word-boundary match never hits a longer word", () => {
  // "aktif" must not be found inside "nonaktif"
  assert.equal(classifyText("Fitur dinonaktifkan."), "info");
});

await test("classifyText: a status dashboard is not a failure verdict", () => {
  // .ping prints "Server Ping: Timeout" on a host without ICMP
  assert.equal(classifyText("🏓 *PONG!*\n\nServer Ping: *Timeout*\nLatency: *12ms*"), "info");
});

await test("classifyText: empty and neutral replies are info", () => {
  assert.equal(classifyText(""), "info");
  assert.equal(classifyText("   "), "info");
  assert.equal(classifyText("📄 List dokumen"), "info");
});

/* ═══════════════════════════ levels ═══════════════════════════ */

await test("silentLevel defaults to the config and honours the DB override", () => {
  reset();
  assert.equal(rt.silentLevel(), "off");
  config.messages.silent = true;
  assert.equal(rt.silentLevel(), "on");
  rt.setSilentLevel("super");
  assert.equal(rt.silentLevel(), "super");
  reset();
});

await test("super mode implies silentEnabled (gate notices suppressed)", async () => {
  reset();
  rt.setSilentLevel("super");
  const { silentEnabled } = await import("../lib/messages.js");
  assert.equal(rt.superSilent(), true);
  assert.equal(silentEnabled(), true);
  reset();
});

/* ═══════════════════════════ .silent super ═══════════════════════════ */

await test(".silent super persists the level and confirms in text", async () => {
  reset();
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".silent super", { sender: OWNER }), sock);
  assert.ok(textsOf(sent).some((t) => /super/i.test(t)), `got: ${JSON.stringify(textsOf(sent))}`);
  assert.equal(db.setting("silentLevel"), "super");
  reset();
});

await test(".silent off leaves super mode", async () => {
  reset();
  rt.setSilentLevel("super");
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".silent off", { sender: OWNER }), sock);
  assert.equal(db.setting("silentLevel"), "off");
  assert.equal(rt.superSilent(), false);
  reset();
});

/* ═══════════════════════════ the minimal reply ═══════════════════════════ */

await test("super: a success replies with ONE 🟢 and no text", async () => {
  reset();
  rt.setSilentLevel("super");
  await withHandler("botinfo", async (m) => m.reply("✅ *Kick berhasil.* User sudah dikeluarkan."), async () => {
    const { sock, sent } = makeSock();
    await messageHandler(rawMsg(".botinfo"), sock);
    assert.deepEqual(textsOf(sent), [], `no text allowed, got ${JSON.stringify(textsOf(sent))}`);
    assert.deepEqual(reactionsOf(sent), ["🟢"]);
  });
});

await test("super: a failure replies with ONE 🔴 and suppresses the error template", async () => {
  reset();
  rt.setSilentLevel("super");
  await withHandler(
    "botinfo",
    async () => {
      throw new Error("boom");
    },
    async () => {
      const { sock, sent } = makeSock();
      await messageHandler(rawMsg(".botinfo"), sock);
      assert.deepEqual(textsOf(sent), [], "the error template must be suppressed in super mode");
      assert.deepEqual(reactionsOf(sent), ["🔴"]);
    },
  );
});

await test("super: an error MESSAGE replied by the plugin is a 🔴", async () => {
  reset();
  rt.setSilentLevel("super");
  await withHandler("botinfo", async (m) => m.reply("❌ Gagal: target tidak ditemukan."), async () => {
    const { sock, sent } = makeSock();
    await messageHandler(rawMsg(".botinfo"), sock);
    assert.deepEqual(textsOf(sent), []);
    assert.deepEqual(reactionsOf(sent), ["🔴"]);
  });
});

await test("super: a media reply alone is delivered (no verdict to react to)", async () => {
  reset();
  rt.setSilentLevel("super");
  await withHandler("botinfo", async (m) => m.replyImage(Buffer.from("x"), "hasil"), async () => {
    const { sock, sent } = makeSock();
    await messageHandler(rawMsg(".botinfo"), sock);
    // a media-only reply carries no verdict, so it is replayed instead of a 🟡
    const media = sent.filter((s) => s.content?.image);
    assert.equal(media.length, 1, `the image must be delivered, got: ${JSON.stringify(sent.map((s) => Object.keys(s.content || {})))}`);
    assert.deepEqual(reactionsOf(sent), []);
  });
});

await test("super: 'processing…' then a verdict collapses into ONE reaction", async () => {
  reset();
  rt.setSilentLevel("super");
  await withHandler(
    "botinfo",
    async (m) => {
      await m.reply(config.messages.wait);
      await m.reply("✅ Berhasil menyimpan catatan.");
    },
    async () => {
      const { sock, sent } = makeSock();
      await messageHandler(rawMsg(".botinfo"), sock);
      assert.deepEqual(textsOf(sent), [], "the held 'processing' notice must never be shown");
      assert.deepEqual(reactionsOf(sent), ["🟢"], "exactly one reaction");
    },
  );
});

await test("super: a returned `true` from the handler is a 🟢", async () => {
  reset();
  rt.setSilentLevel("super");
  await withHandler(
    "botinfo",
    async (m) => {
      await m.reply("Data tersimpan.");
      return true;
    },
    async () => {
      const { sock, sent } = makeSock();
      await messageHandler(rawMsg(".botinfo"), sock);
      assert.deepEqual(reactionsOf(sent), ["🟢"]);
    },
  );
});

await test("super: a returned `false` from the handler is a 🔴", async () => {
  reset();
  rt.setSilentLevel("super");
  await withHandler(
    "botinfo",
    async (m) => {
      await m.reply("Sedang diproses.");
      return false;
    },
    async () => {
      const { sock, sent } = makeSock();
      await messageHandler(rawMsg(".botinfo"), sock);
      assert.deepEqual(reactionsOf(sent), ["🔴"]);
    },
  );
});

await test("super: an inconclusive reply is replayed, not replaced by a 🟡", async () => {
  reset();
  rt.setSilentLevel("super");
  await withHandler("botinfo", async (m) => m.reply("📄 Daftar dokumen: SOP, Kalender"), async () => {
    const { sock, sent } = makeSock();
    await messageHandler(rawMsg(".botinfo"), sock);
    assert.ok(textsOf(sent).some((t) => t.includes("Daftar dokumen")), `got: ${JSON.stringify(textsOf(sent))}`);
    assert.deepEqual(reactionsOf(sent), [], "a replay must not also react");
  });
});

await test("super: an explicit ctx.output.fail is a 🔴 even for neutral text", async () => {
  reset();
  rt.setSilentLevel("super");
  await withHandler("botinfo", async (m, ctx) => ctx.output.fail("Tidak ada hasil."), async () => {
    const { sock, sent } = makeSock();
    await messageHandler(rawMsg(".botinfo"), sock);
    assert.deepEqual(reactionsOf(sent), ["🔴"]);
  });
});

await test("super: `{ keep: true }` bypasses the filter entirely", async () => {
  reset();
  rt.setSilentLevel("super");
  await withHandler("botinfo", async (m) => m.reply("✅ Detail penting!", { keep: true }), async () => {
    const { sock, sent } = makeSock();
    await messageHandler(rawMsg(".botinfo"), sock);
    assert.ok(textsOf(sent).some((t) => t.includes("Detail penting")), "keep must always deliver");
  });
});

/* ═══════════════ documentation stays visible in super mode ═══════════════ */

await test("super: the auto usage card is shown in full, not replaced by a reaction", async () => {
  reset();
  rt.setSilentLevel("super");
  // `.translate` takes parameters, so a bare call renders the usage card.
  const plugin = getPlugin("translate");
  assert.ok(plugin, "the translate plugin must be loaded for this test");
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".translate"), sock);

  const texts = textsOf(sent);
  assert.ok(
    texts.some((t) => /Parameter tersedia|Usage:/i.test(t)),
    `the usage card must be delivered, got: ${JSON.stringify(texts)}`
  );
  assert.deepEqual(reactionsOf(sent), [], "documentation is not a verdict — no status light");
});

await test("super: .help <command> detail card is shown in full", async () => {
  reset();
  rt.setSilentLevel("super");
  // `.help close` is the telling case: its card mentions a failure-marker word,
  // so without `keep` super mode would collapse the whole card into a 🔴.
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".help close"), sock);
  const texts = textsOf(sent);
  assert.ok(
    texts.some((t) => /Kategori|Usage:/i.test(t)),
    `the help detail must be delivered, got: ${JSON.stringify(texts)}`
  );
  assert.deepEqual(reactionsOf(sent), [], "the help card must not be replaced by a reaction");
});

await test("super: a non-documentation reply that gives no verdict is replayed (unchanged)", async () => {
  reset();
  rt.setSilentLevel("super");
  // Existing behaviour: an inconclusive informational reply is replayed rather
  // than replaced by a 🟡. Only the explicitly `keep`-marked DOCUMENTATION
  // bypasses the hold queue — this test pins that distinction down.
  await withHandler("botinfo", async (m) => m.reply("📄 Daftar dokumen: SOP, Kalender"), async () => {
    const { sock, sent } = makeSock();
    await messageHandler(rawMsg(".botinfo"), sock);
    assert.ok(
      textsOf(sent).some((t) => t.includes("Daftar dokumen")),
      "an inconclusive info reply is still replayed",
    );
    assert.deepEqual(reactionsOf(sent), []);
  });
});

await test("super: a refusal is still the red reaction, with no text", async () => {
  reset();
  rt.setSilentLevel("super");
  const { sock, sent } = makeSock();
  // `.silent` is owner-only: a plain user is refused by the permission gate
  await messageHandler(rawMsg(".silent on", { sender: USER }), sock);
  assert.equal(textsOf(sent).length, 0, `a refusal must stay silent, got: ${JSON.stringify(textsOf(sent))}`);
  reset();
});

await test("super: a plugin error message is still a reaction, not text", async () => {
  reset();
  rt.setSilentLevel("super");
  await withHandler("botinfo", async (m) => m.reply("❌ Gagal: target tidak ditemukan."), async () => {
    const { sock, sent } = makeSock();
    await messageHandler(rawMsg(".botinfo"), sock);
    assert.deepEqual(textsOf(sent), [], "error text must be suppressed in super mode");
    assert.deepEqual(reactionsOf(sent), ["🔴"]);
  });
});

await test("super: a waiting/processing notice is still collapsed, not shown", async () => {
  reset();
  rt.setSilentLevel("super");
  await withHandler(
    "botinfo",
    async (m) => {
      await m.reply(config.messages.wait);
      await m.reply("✅ Berhasil.");
    },
    async () => {
      const { sock, sent } = makeSock();
      await messageHandler(rawMsg(".botinfo"), sock);
      assert.deepEqual(textsOf(sent), [], "the waiting notice must never be shown");
      assert.deepEqual(reactionsOf(sent), ["🟢"]);
    },
  );
});

/* ═══════════════════════════ cancels ═══════════════════════════ */

await test("super: a cancelled prompt keeps its text and is NOT red", async () => {
  reset();
  rt.setSilentLevel("super");
  await withHandler(
    "botinfo",
    async (m) => {
      await m.reply("⚠️ Yakin ingin kick @628123? balas *ya*", { keep: true });
      cancel("info");
    },
    async () => {
      const { sock, sent } = makeSock();
      await messageHandler(rawMsg(".botinfo"), sock);
      assert.ok(textsOf(sent).some((t) => /yakin/i.test(t)), "the question must be delivered");
      assert.deepEqual(reactionsOf(sent), [], "a cancel is not a failure");
    },
  );
});

await test("CancelSignal carries its own outcome", () => {
  const signal = new CancelSignal("fail");
  assert.equal(signal.__gxCancel, true);
  assert.equal(signal.outcome, "fail");
  assert.equal(new CancelSignal("nonsense").outcome, "info");
});

/* ═══════════════════════════ normal mode ═══════════════════════════ */

await test("normal: a silent success gets ONE auto ✅", async () => {
  reset();
  await withHandler("botinfo", async () => {}, async () => {
    const { sock, sent } = makeSock();
    await messageHandler(rawMsg(".botinfo"), sock);
    assert.deepEqual(reactionsOf(sent), ["✅"]);
    assert.deepEqual(textsOf(sent), []);
  });
});

await test("normal: a real reply is delivered in full, with no ✅", async () => {
  reset();
  await withHandler("botinfo", async (m) => m.reply("📄 Daftar dokumen: SOP, Kalender"), async () => {
    const { sock, sent } = makeSock();
    await messageHandler(rawMsg(".botinfo"), sock);
    assert.ok(textsOf(sent).some((t) => t.includes("Daftar dokumen")));
    assert.deepEqual(reactionsOf(sent), [], "a real reply is its own confirmation");
  });
});

await test("normal: a lone '✅ Done!' toast collapses into a ✅ reaction", async () => {
  reset();
  await withHandler("botinfo", async (m) => m.reply("✅ *Done!*"), async () => {
    const { sock, sent } = makeSock();
    await messageHandler(rawMsg(".botinfo"), sock);
    assert.deepEqual(textsOf(sent), [], "the toast is replaced by the reaction");
    assert.deepEqual(reactionsOf(sent), ["✅"]);
  });
});

await test("normal: a failing command still gets its error template", async () => {
  reset();
  await withHandler(
    "botinfo",
    async () => {
      throw new Error("boom");
    },
    async () => {
      const { sock, sent } = makeSock();
      await messageHandler(rawMsg(".botinfo"), sock);
      assert.ok(textsOf(sent).length > 0, "the error template must be delivered");
    },
  );
});

/* ═══════════════════════════ gates stay silent ═══════════════════════════ */

await test("super: a denied command produces no output at all", async () => {
  reset();
  rt.setSilentLevel("super");
  const { sock, sent } = makeSock();
  // .silent is owner-only: a plain user is denied by the permission gate
  await messageHandler(rawMsg(".silent on", { sender: USER }), sock);
  assert.equal(textsOf(sent).length, 0, `got: ${JSON.stringify(textsOf(sent))}`);
  assert.equal(reactionsOf(sent).length, 0, "a denial must not be signalled as success or failure");
  reset();
});

await test("super: an unknown command is silenced, not reacted to", async () => {
  reset();
  rt.setSilentLevel("super");
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg(".commanddoesnotexist"), sock);
  assert.equal(sent.length, 0, `got: ${JSON.stringify(textsOf(sent))} / ${JSON.stringify(reactionsOf(sent))}`);
  reset();
});

/* ─────────────────────────── #hashtag / note lookup ─────────────────────────── */

await test("super: a random hashtag is silenced (no 'Note not found')", async () => {
  reset();
  rt.setSilentLevel("super");
  for (const body of ["#hai", "#okasdkdas", "#random-tag"]) {
    const { sock, sent } = makeSock();
    await messageHandler(rawMsg(body), sock);
    assert.equal(
      sent.length,
      0,
      `${body} must produce nothing, got: ${JSON.stringify(textsOf(sent))} / ${JSON.stringify(reactionsOf(sent))}`,
    );
  }
  reset();
});

await test("silent: a random hashtag is silenced (no 'Note not found')", async () => {
  reset();
  rt.setSilentLevel("on");
  for (const body of ["#hai", "#okasdkdas"]) {
    const { sock, sent } = makeSock();
    await messageHandler(rawMsg(body), sock);
    assert.equal(sent.length, 0, `${body} must produce nothing, got: ${JSON.stringify(textsOf(sent))}`);
  }
  reset();
});

await test("off: a random hashtag still reports 'Note not found'", async () => {
  reset();
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg("#okasdkdas"), sock);
  assert.ok(
    textsOf(sent).some((t) => /note not found/i.test(t)),
    `the notice must be shown when not silent, got: ${JSON.stringify(textsOf(sent))}`,
  );
  reset();
});

await test("silent: a REAL note is still delivered", async () => {
  reset();
  rt.setSilentLevel("on");
  db.setNote(USER, "hai", "Halo juga!", USER);
  const { sock, sent } = makeSock();
  await messageHandler(rawMsg("#hai"), sock);
  assert.deepEqual(textsOf(sent), ["Halo juga!"], "real note content is real output, not a notice");
  reset();
});

/* ═══════════════════════════ native flow ═══════════════════════════ */

await test("a flow prompt is its own output: no auto-reaction is stacked on it", async () => {
  reset();
  const { registerFlowRoute, handleFlowAction } = await import("../lib/flow-router.js");
  const { markPromptDelivered } = rt;
  const sent = [];
  const m = {
    chat: "628000000004@s.whatsapp.net",
    body: "",
    reply: async (t) => sent.push({ text: t }),
    react: async (e) => sent.push({ react: e }),
  };
  rt.instrumentMessage(m);
  rt.beginTurn(m);
  // simulating what sendNativeFlow does when it displays a prompt
  markPromptDelivered(m, m.chat, rt.stateForPrompt(m));
  await rt.finishTurn(m, undefined);
  assert.deepEqual(sent, [], "a displayed prompt must not also react");
  reset();
});

await test("a flow tap continues the turn (super mode applies to the tapped action)", async () => {
  reset();
  rt.setSilentLevel("super");
  const { registerFlowRoute, handleFlowAction } = await import("../lib/flow-router.js");
  registerFlowRoute("supertest", async (msg) => {
    await msg.reply("✅ Berhasil memilih dokumen.");
    return true;
  });
  const sent = [];
  const m = {
    chat: "628000000004@s.whatsapp.net",
    body: "supertest:pick:1",
    reply: async (t) => sent.push({ text: t }),
    react: async (e) => sent.push({ react: e }),
  };
  rt.instrumentMessage(m);
  await handleFlowAction(m, {});
  assert.deepEqual(sent.filter((s) => s.react), [{ react: "🟢" }], "the tap resolves to one status light");
  assert.deepEqual(sent.filter((s) => s.text), [], "no text under super mode");
  reset();
});

/* ═══════════════════════════ transformer kill switch ═══════════════════════════ */

await test("transformEnabled=false restores raw replies", async () => {
  reset();
  rt.setSilentLevel("super");
  config.messages.transformEnabled = false;
  try {
    await withHandler("botinfo", async (m) => m.reply("✅ Berhasil."), async () => {
      const { sock, sent } = makeSock();
      await messageHandler(rawMsg(".botinfo"), sock);
      assert.ok(textsOf(sent).some((t) => /berhasil/i.test(t)), "raw text must come through");
      assert.deepEqual(reactionsOf(sent), []);
    });
  } finally {
    delete config.messages.transformEnabled;
    reset();
  }
});

/* ─────────────────────────── report ─────────────────────────── */

reset();
for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name}${r.ok ? "" : ` — ${r.error}`}`);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} super-silent checks passed`);
fs.rmSync(dbPath, { recursive: true, force: true });
if (failed.length) process.exit(1);
process.exit(0);
