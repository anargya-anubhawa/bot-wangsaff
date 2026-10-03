/**
 * GX-ID — hot reload test
 *
 * Verifies the plugin hot-reload path (cache-busted re-import) picks up on-disk
 * edits, and that the `.reload` / `.restart` owner commands are registered.
 */
import assert from "assert";
import fs from "fs";
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

const { loadPlugins, getPlugin, getPluginCount } = await import("../lib/plugins.js");

const tmpDir = path.join(process.cwd(), "plugins", "__hotreload_test__");
fs.rmSync(tmpDir, { recursive: true, force: true });
fs.mkdirSync(tmpDir, { recursive: true });

const fileA = path.join(tmpDir, "alpha.js");
const fileB = path.join(tmpDir, "beta.js");

function writePlugin(file, { name, description }) {
  fs.writeFileSync(
    file,
    `const pluginConfig = { name: ${JSON.stringify(name)}, category: "test", description: ${JSON.stringify(description)}, isEnabled: true };\n` +
      `async function handler() {}\n` +
      `export { pluginConfig as config, handler };\n`,
  );
}

writePlugin(fileA, { name: "alpha", description: "first" });
writePlugin(fileB, { name: "beta", description: "beta" });

// load only our isolated dir so the test is fast and deterministic
const silent = console.log;
console.log = () => {};
const count = await loadPlugins(tmpDir);
console.log = silent;

await test("initial load registers both plugins", () => {
  assert.equal(count, 2);
  assert.ok(getPlugin("alpha"));
  assert.ok(getPlugin("beta"));
});

await test("hot reload picks up a description edit", async () => {
  writePlugin(fileA, { name: "alpha", description: "second" });
  console.log = () => {};
  await loadPlugins(tmpDir, { bustCache: true });
  console.log = silent;
  assert.equal(getPlugin("alpha").config.description, "second");
});

await test("hot reload picks up a new plugin file", async () => {
  writePlugin(path.join(tmpDir, "gamma.js"), { name: "gamma", description: "new" });
  console.log = () => {};
  await loadPlugins(tmpDir, { bustCache: true });
  console.log = silent;
  assert.ok(getPlugin("gamma"), "gamma should be registered after reload");
});

await test("hot reload removes a deleted plugin", async () => {
  fs.rmSync(fileB, { force: true });
  console.log = () => {};
  await loadPlugins(tmpDir, { bustCache: true });
  console.log = silent;
  assert.equal(getPlugin("beta"), null, "beta should be gone after reload");
});

// real plugin dir — verify the new owner commands exist
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log = () => {};
await loadPlugins(path.join(process.cwd(), "plugins"));
console.log = silent;

await test(".reload command registered in owner category", () => {
  const p = getPlugin("reload");
  assert.ok(p, "reload missing");
  assert.equal(p.config.category, "owner");
  assert.equal(p.config.permission, "owner");
});

await test(".restart command registered in owner category", () => {
  const p = getPlugin("restart");
  assert.ok(p, "restart missing");
  assert.equal(p.config.category, "owner");
  assert.equal(p.config.permission, "owner");
});

await test(".reload aliases resolve", () => {
  for (const a of ["reloadplugin", "reloadplugins", "hotreload"]) {
    assert.equal(getPlugin(a)?.config?.name, "reload", `alias ${a} broken`);
  }
});

await test(".restart aliases resolve", () => {
  for (const a of ["reboot", "restartbot", "rebootbot"]) {
    assert.equal(getPlugin(a)?.config?.name, "restart", `alias ${a} broken`);
  }
});

await test("restart helpers exported", async () => {
  const mod = await import("../lib/restart.js");
  for (const fn of ["restartBot", "shutdownResources", "isWatchMode", "isUnderSupervisor", "isRestarting"]) {
    assert.equal(typeof mod[fn], "function", `missing ${fn}`);
  }
});

await test("hot-reload module exports startHotReload", async () => {
  const mod = await import("../lib/hot-reload.js");
  assert.equal(typeof mod.startHotReload, "function");
  // disabled path returns a no-op controller
  const ctrl = mod.startHotReload({ root: process.cwd() });
  assert.equal(typeof ctrl.stop, "function");
  assert.equal(typeof ctrl.enabled, "boolean");
  ctrl.stop();
});

await test("plugin entry files are tracked; shared modules are not", async () => {
  const { isPluginEntryFile, getLoadedPluginFiles } = await import("../lib/plugins.js");
  const entries = getLoadedPluginFiles();
  assert.ok(entries.length > 0, "no entry files tracked");
  // a real plugin entry is recognised
  const menuEntry = path.join(process.cwd(), "plugins", "main", "menu.js");
  assert.equal(isPluginEntryFile(menuEntry), true, "menu.js should be an entry");
  // a shared helper module is NOT an entry (must trigger a restart)
  const shared = path.join(process.cwd(), "plugins", "main", "category.js");
  assert.equal(isPluginEntryFile(shared), false, "category.js must not be an entry");
  // an arbitrary file is not an entry
  assert.equal(isPluginEntryFile(path.join(process.cwd(), "config.js")), false);
});

await test("change classification picks soft reload vs restart", async () => {
  const { classifyPluginChange, isImportedByPlugin } = await import("../lib/plugins.js");
  const standalone = path.join(process.cwd(), "plugins", "owner", "reload.js");
  assert.equal(classifyPluginChange(standalone), "entry", "standalone plugin should soft reload");

  // a shared helper module → restart
  const shared = path.join(process.cwd(), "plugins", "main", "category.js");
  assert.equal(classifyPluginChange(shared), "restart", "shared module should restart");

  // a plugin entry that is ALSO imported by other plugins → restart
  const werewolf = path.join(process.cwd(), "plugins", "game", "werewolf.js");
  assert.equal(isImportedByPlugin(werewolf), true, "werewolf.js is imported by wwsorcerer etc.");
  assert.equal(classifyPluginChange(werewolf), "restart", "imported entry should restart");

  // a self-contained plugin is not imported by anyone
  assert.equal(isImportedByPlugin(standalone), false);
});

await test(".reload status handler replies with registry size", async () => {
  const { handler } = await import("../plugins/owner/reload.js");
  const replies = [];
  const m = { args: ["status"], prefix: ".", reply: async (t) => replies.push(t) };
  console.log = () => {};
  await handler(m, { config: { command: { prefix: "." } } });
  console.log = silent;
  assert.ok(replies[0]?.includes("Plugin Registry"), `got: ${replies[0]}`);
  assert.ok(replies[0].includes(String(getPluginCount())), "should include the plugin count");
});

await test(".reload handler actually reloads plugins", async () => {
  const { handler } = await import("../plugins/owner/reload.js");
  const replies = [];
  const m = { args: [], prefix: ".", reply: async (t) => replies.push(t) };
  console.log = () => {};
  await handler(m, { config: { command: { prefix: "." } } });
  console.log = silent;
  assert.ok(replies[0]?.includes("Plugin dimuat ulang"), `got: ${replies[0]}`);
  assert.ok(replies[0].includes("Durasi"), "should report elapsed time");
});

await test(".restart status handler reports the restart mode", async () => {
  const { handler } = await import("../plugins/owner/restart.js");
  const replies = [];
  const m = { args: ["status"], prefix: ".", reply: async (t) => replies.push(t) };
  await handler(m, { config: { command: { prefix: "." } } });
  assert.ok(replies[0]?.includes("Restart"), `got: ${replies[0]}`);
  assert.ok(replies[0].includes("Mode"), "should report the mode");
});

fs.rmSync(tmpDir, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "✓" : "✗"} ${r.name}${r.ok ? "" : ` — ${r.error}`}`);
console.log(`\n${results.length - failed.length}/${results.length} hot-reload checks passed`);
process.exit(failed.length ? 1 : 0);
