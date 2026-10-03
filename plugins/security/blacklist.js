/**
 * GX-ID — /blacklist (admin target / owner / whitelist)
 *
 * Unified blacklist command, merging the former `blacklist` (add), `blacklists`
 * (list) and `unblacklist` (remove) plugins. Every original entry point is
 * preserved as an alias, so existing usages keep working, while the unified
 * interface is parameter driven:
 *
 *   .blacklist [grup|global] <kata|re:pola>   → add an entry
 *   .blacklist list [grup|global|all]         → list entries (plain text)
 *   .blacklist del [grup|global] <kata>       → remove an entry
 *
 * A blacklist bans a word/phrase (or a `re:` regex) in a group: any message
 * containing it from an ordinary member is deleted. There is no separate
 * on/off toggle — the blacklist is active the moment it has at least one entry.
 *
 * Aliases (back-compat): addblacklist/larang, blacklists/listblacklist/
 * daftarblacklist, unblacklist/delblacklist/hapusblacklist.
 */
import { validateEntry, normalizeEntry } from "../../lib/content-detectors.js";
import { splitQuotedArg, stripQuotes } from "../../lib/plugin-utils.js";
import { resolveManagedTarget, resolveGroup } from "../../lib/group-registry.js";
import { resolveScopeId, listEffectiveBlacklist, isGlobalTarget, GLOBAL_SCOPE, GLOBAL_KEYWORD } from "../../lib/group-scope.js";
import { isOwnerOrWhitelistedIn } from "../../lib/access.js";

const ADD_ALIASES = ["addblacklist", "larang"];
const LIST_ALIASES = ["blacklists", "listblacklist", "daftarblacklist"];
const DEL_ALIASES = ["unblacklist", "delblacklist", "hapusblacklist"];

const pluginConfig = {
  name: "blacklist",
  alias: [...ADD_ALIASES, ...LIST_ALIASES, ...DEL_ALIASES],
  category: "security",
  description: "Kelola blacklist (larangan kata) sebuah grup",
  usage: ".blacklist [list|del] [grup|global] <kata|re:pola>",
  examples: [".blacklist judi", ".blacklist list", ".blacklist del judi"],
  parameters: [
    { name: "list", description: "Tampilkan blacklist" },
    { name: "del", description: "Hapus: del [grup|global] <kata|re:pola>" },
    { name: "grup", description: "Target grup (alias/id)" },
    { name: "global", description: "Scope global (owner)" },
    { name: "<kata|re:pola>", description: "Kata atau pola regex (re:...)" },
  ],
  helpOnEmpty: true,
  permission: "all",
  cooldown: 5,
  isEnabled: true,
};

/** Split `<target|global> <phrase>` when the first token is a group or `global`. */
function splitTargetPhrase(text) {
  const { first, rest } = splitQuotedArg(text);
  if (rest && (resolveGroup(first) || isGlobalTarget(first))) {
    return { targetArg: first, globalScope: isGlobalTarget(first), phrase: stripQuotes(rest) };
  }
  return { targetArg: null, globalScope: false, phrase: stripQuotes(text) };
}

/* ─────────────────────────── add ─────────────────────────── */

async function handleAdd(m, ctx, text) {
  const prefix = m.prefix || ctx.config?.command?.prefix || ".";
  const { targetArg, globalScope, phrase } = splitTargetPhrase(text);

  if (!phrase) {
    return m.reply(`🚫 *Blacklist*\n\n> Usage: \`${prefix}blacklist [grup|${GLOBAL_KEYWORD}] <kata|re:pola>\`\n> Contoh: \`${prefix}blacklist kelas-a judi\``);
  }

  if (globalScope && !isOwnerOrWhitelistedIn(m)) {
    return m.reply(`🔒 *Hanya owner* yang boleh menambah blacklist \`${GLOBAL_KEYWORD}\`.`);
  }

  const target = globalScope
    ? { jid: GLOBAL_SCOPE, alias: GLOBAL_KEYWORD, registration: null }
    : await resolveManagedTarget(m, ctx, { args: targetArg ? [targetArg] : [] });
  if (target.error) return m.reply(target.error);

  const error = validateEntry(phrase);
  if (error) return m.reply(`❌ ${error}`);

  // Blacklists may be shared between linked groups — use the shared scope.
  const scope = globalScope ? GLOBAL_SCOPE : resolveScopeId("blacklist", target.jid);
  const entry = normalizeEntry(phrase);
  const existing = ctx.db.listBlacklist(scope).some((e) => e.entry === entry);
  if (existing) return m.reply(`⚠️ \`${entry}\` sudah ada di blacklist grup itu.`);

  ctx.db.addBlacklist(scope, entry, m.sender);
  const label = target.alias || target.jid.split("@")[0];
  await m.reply(
    `✅ \`${entry}\` ditambahkan ke blacklist *${label}*.\n\n> Total: ${ctx.db.listBlacklist(scope).length} entri.`,
  );
}

/* ─────────────────────────── list ─────────────────────────── */

function renderList(title, entries) {
  return (
    `🚫 *${title} (${entries.length})*\n\n` +
    entries.map((e, i) => `┃ ${i + 1}. \`${e.entry}\``).join("\n") +
    `\n\n> Hapus: \`.unblacklist <kata>\``
  );
}

async function handleList(m, ctx, arg) {
  const { db } = ctx;
  const prefix = m.prefix || ctx.config?.command?.prefix || ".";
  const lower = String(arg || "").toLowerCase();

  if (lower === "all") {
    if (!m.isOwner) return m.reply("🔒 *Hanya owner* yang boleh melihat blacklist semua grup.");
    const sections = [];
    const globals = db.listBlacklist(GLOBAL_SCOPE).sort((a, b) => a.entry.localeCompare(b.entry));
    if (globals.length) sections.push(`🌐 *${GLOBAL_KEYWORD.toUpperCase()}* (${globals.length})\n${globals.map((e) => `┃ \`${e.entry}\``).join("\n")}`);
    const seenScopes = new Set([GLOBAL_SCOPE]);
    for (const reg of db.listRegistrations()) {
      const scopeId = resolveScopeId("blacklist", reg.jid);
      if (seenScopes.has(scopeId)) continue;
      const entries = db.listBlacklist(scopeId).sort((a, b) => a.entry.localeCompare(b.entry));
      if (!entries.length) continue;
      seenScopes.add(scopeId);
      const label = reg.alias || String(reg.jid).split("@")[0];
      sections.push(`📁 *${label}* (${entries.length})\n${entries.map((e) => `┃ \`${e.entry}\``).join("\n")}`);
    }
    if (!sections.length) return m.reply("🚫 *Belum ada blacklist di grup mana pun.*");
    return m.reply(`🚫 *Semua Blacklist*\n\n${sections.join("\n\n")}`);
  }

  if (isGlobalTarget(arg)) {
    const entries = db.listBlacklist(GLOBAL_SCOPE).sort((a, b) => a.entry.localeCompare(b.entry));
    if (!entries.length) {
      return m.reply(`🚫 *Blacklist ${GLOBAL_KEYWORD} kosong.*\n\n> Tambah: \`${prefix}blacklist ${GLOBAL_KEYWORD} <kata>\``);
    }
    return m.reply(renderList(`Blacklist ${GLOBAL_KEYWORD}`, entries));
  }

  const target = await resolveManagedTarget(m, ctx, { args: arg ? [arg] : [] });
  if (target.error) return m.reply(target.error);

  const entries = listEffectiveBlacklist(db, target.jid).sort((a, b) => a.entry.localeCompare(b.entry));
  const reg = db.getRegistration(target.jid);
  const label = arg ? reg?.alias || String(target.jid).split("@")[0] : "Blacklist";
  if (!entries.length) {
    return m.reply(`🚫 *Blacklist kosong* (${label}).\n\n> Tambahkan dengan \`.blacklist <kata>\``);
  }
  await m.reply(renderList(`Blacklist — ${label}`, entries));
}

/* ─────────────────────────── del ─────────────────────────── */

async function handleDel(m, ctx, text) {
  const prefix = m.prefix || ctx.config?.command?.prefix || ".";
  const { targetArg, globalScope, phrase } = splitTargetPhrase(text);
  if (!phrase) {
    return m.reply(`🚫 *Hapus Blacklist*\n\n> Usage: \`${prefix}blacklist del [grup|${GLOBAL_KEYWORD}] <kata>\``);
  }

  if (globalScope && !isOwnerOrWhitelistedIn(m)) {
    return m.reply(`🔒 *Hanya owner* yang boleh menghapus blacklist \`${GLOBAL_KEYWORD}\`.`);
  }

  const target = globalScope
    ? { jid: GLOBAL_SCOPE, alias: GLOBAL_KEYWORD, registration: null }
    : await resolveManagedTarget(m, ctx, { args: targetArg ? [targetArg] : [] });
  if (target.error) return m.reply(target.error);

  const scope = globalScope ? GLOBAL_SCOPE : resolveScopeId("blacklist", target.jid);
  const removed = ctx.db.removeBlacklist(scope, normalizeEntry(phrase));
  if (!removed) return m.reply(`⚠️ \`${phrase}\` tidak ada di blacklist grup itu.`);
  const label = target.alias || target.jid.split("@")[0];
  await m.reply(`🗑️ \`${phrase}\` dihapus dari blacklist *${label}*.`);
}

/* ─────────────────────────── dispatch ─────────────────────────── */

async function handler(m, ctx) {
  const invoked = String(m.command || "blacklist").toLowerCase();
  const args = m.args || [];
  const text = String(m.text || "").trim();

  if (LIST_ALIASES.includes(invoked)) return handleList(m, ctx, args[0]);
  if (DEL_ALIASES.includes(invoked)) return handleDel(m, ctx, text);
  if (ADD_ALIASES.includes(invoked)) return handleAdd(m, ctx, text);

  /* primary: `.blacklist <sub> ...` */
  const sub = (args[0] || "").toLowerCase();
  const restText = sub ? text.slice(args[0].length).trim() : text;
  if (sub === "list") return handleList(m, ctx, args[1]);
  /* bare `.blacklist all|global` lists; with more text it is an add target */
  if ((sub === "all" || sub === "global") && args.length === 1) return handleList(m, ctx, sub);
  if (sub === "del" || sub === "delete" || sub === "remove" || sub === "unblacklist" || sub === "hapus") {
    return handleDel(m, ctx, restText);
  }
  return handleAdd(m, ctx, text);
}

export { pluginConfig as config, handler };
