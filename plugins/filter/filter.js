/**
 * GX-ID — /filter (admin target / owner / whitelist)
 *
 * Unified filter command, merging the former `addfilter`, `delfilter`,
 * `filters` and `filtercd` plugins. Every original entry point is preserved as
 * an alias, so existing usages keep working, while the unified interface is
 * parameter driven:
 *
 *   .filter [grup|global|all]                 → list filters (numbered)
 *   .filter add [grup|global] <pemicu> <balasan>
 *   .filter del [grup|global] <nomor|pemicu>
 *   .filter cd [grup] <Ns|Nm|Nh>              → filter cooldown
 *
 * Deletion accepts either the trigger itself or the position shown by the
 * list, so `.filter del 1` removes the first filter that `.filter` printed.
 * A literal numeric trigger can still be removed by quoting it (`del "1"`).
 *
 * A filter is a group auto-reply: when an ordinary member's whole message
 * equals the trigger (case-insensitive, or a `re:` regex), the bot replies with
 * the saved text/media. Triggers containing spaces must be quoted.
 *
 * Aliases (back-compat): filters/listfilter/daftarfilter, addfilter/setfilter/
 * tambahfilter, delfilter/removefilter/hapusfilter, filtercd/filtercooldown/
 * jcdafilter.
 */
import { isOwnerOrWhitelistedIn, isGroupAdmin } from "../../lib/access.js";
import { validateEntry, normalizeEntry, isRegexEntry } from "../../lib/content-detectors.js";
import { detectMediaType, getMimetype, downloadMedia } from "../../lib/media.js";
import { splitQuotedArg, stripQuotes } from "../../lib/plugin-utils.js";
import { resolveGroup, resolveDataTarget, resolveManagedTarget } from "../../lib/group-registry.js";
import { resolveScopeId, isGlobalTarget, listEffectiveFilters, GLOBAL_SCOPE, GLOBAL_KEYWORD } from "../../lib/group-scope.js";
import { setFilterCooldown, getFilterCooldown } from "../../lib/cooldown.js";

const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
const ALLOWED_MEDIA = new Set(["image", "audio", "sticker"]);

const LIST_ALIASES = ["filters", "listfilter", "daftarfilter"];
const ADD_ALIASES = ["addfilter", "setfilter", "tambahfilter"];
const DEL_ALIASES = ["delfilter", "removefilter", "hapusfilter"];
const CD_ALIASES = ["filtercd", "filtercooldown", "jcdafilter"];

const pluginConfig = {
  name: "filter",
  alias: [...LIST_ALIASES, ...ADD_ALIASES, ...DEL_ALIASES, ...CD_ALIASES],
  category: "filter",
  description: "Kelola filter (balasan otomatis) sebuah grup",
  usage: ".filter [list|add|del|cd] ...",
  examples: [".filter", ".filter add halo Halo juga!", ".filter del 1", ".filter del halo", ".filter cd 30s"],
  parameters: [
    { name: "list", description: "Tampilkan filter beserta nomor urutnya (default)" },
    { name: "add", description: "Tambah: add [grup|global] <pemicu> <balasan>" },
    { name: "del", description: "Hapus: del [grup|global] <nomor|pemicu>" },
    { name: "cd", description: "Cooldown: cd [grup] <Ns|Nm|Nh>" },
    { name: "grup", description: "Target grup (alias/id)" },
    { name: "global", description: "Scope global (owner)" },
    { name: "all", description: "Lihat semua grup (owner)" },
  ],
  helpOnEmpty: true,
  permission: "all",
  cooldown: 3,
  isEnabled: true,
};

/* ─────────────────────────── list ─────────────────────────── */

function quoteTrigger(trigger) {
  return /\s/.test(trigger) ? `"${trigger}"` : trigger;
}

/** The fixed order used for numbering — shared by the list and by `del <n>`. */
function sortedFilters(filters) {
  return [...filters].sort((a, b) => a.trigger.localeCompare(b.trigger));
}

function renderList(title, filters, prefix = ".") {
  const lines = [
    `*${title} (${filters.length})*`,
    "",
    ...filters.map((f, i) => `${i + 1}. \`${quoteTrigger(f.trigger)}\`${isRegexEntry(f.trigger) ? " (regex)" : ""}`),
    "",
    `Hapus: \`${prefix}filter del <nomor|pemicu>\``,
  ];
  return lines.join("\n");
}

async function handleList(m, ctx, arg) {
  const { db } = ctx;
  const prefix = m.prefix || ctx.config?.command?.prefix || ".";
  const lower = String(arg || "").toLowerCase();

  if (lower === "all") {
    if (!m.isOwner) return m.reply("*Hanya owner* yang boleh melihat filter semua grup.");
    const sections = [];
    const globals = sortedFilters(db.listFilters(GLOBAL_SCOPE));
    if (globals.length) sections.push(`*${GLOBAL_KEYWORD.toUpperCase()}* (${globals.length})\n${globals.map((f) => `- \`${quoteTrigger(f.trigger)}\``).join("\n")}`);
    const seenScopes = new Set([GLOBAL_SCOPE]);
    for (const reg of db.listRegistrations()) {
      const scopeId = resolveScopeId("filters", reg.jid);
      if (seenScopes.has(scopeId)) continue;
      const filters = sortedFilters(db.listFilters(scopeId));
      if (!filters.length) continue;
      seenScopes.add(scopeId);
      const label = reg.alias || String(reg.jid).split("@")[0];
      sections.push(`*${label}* (${filters.length})\n${filters.map((f) => `- \`${quoteTrigger(f.trigger)}\``).join("\n")}`);
    }
    if (!sections.length) return m.reply("*Belum ada filter di grup mana pun.*");
    return m.reply(`*Semua Filter*\n\n${sections.join("\n\n")}`);
  }

  if (isGlobalTarget(arg)) {
    const filters = sortedFilters(db.listFilters(GLOBAL_SCOPE));
    if (!filters.length) {
      return m.reply(`*Belum ada filter ${GLOBAL_KEYWORD}.*\n\nTambah: \`${prefix}filter add ${GLOBAL_KEYWORD} <pemicu> <balasan>\``);
    }
    return m.reply(renderList(`Filter ${GLOBAL_KEYWORD}`, filters, prefix));
  }

  const target = await resolveManagedTarget(m, ctx, { args: arg ? [arg] : [] });
  if (target.error) return m.reply(target.error);

  const filters = sortedFilters(listEffectiveFilters(db, target.jid));
  if (!filters.length) {
    return m.reply(`*Belum ada filter.*\n\nTambahkan dengan \`${prefix}filter add <pemicu> <balasan>\``);
  }
  const reg = db.getRegistration(target.jid);
  const label = arg ? reg?.alias || String(target.jid).split("@")[0] : "Filter";
  await m.reply(renderList(label, filters, prefix));
}

/* ─────────────────────────── add ─────────────────────────── */

async function handleAdd(m, ctx, args, text) {
  const { db, sock } = ctx;
  const prefix = m.prefix || ctx.config?.command?.prefix || ".";
  const quoted = m.quoted;

  /* optional leading target: `.filter add <grup|global> <pemicu> ...` */
  let targetArg = null;
  let globalScope = false;
  let body = String(text || "").trim();
  if (args.length >= 2 && (resolveGroup(args[0]) || isGlobalTarget(args[0]))) {
    targetArg = args[0];
    globalScope = isGlobalTarget(args[0]);
    body = body.slice(targetArg.length).trim();
  }

  /* Reply-first: when replying, the WHOLE argument text is the trigger (so a
     phrase or regex with spaces needs no quoting). Otherwise the first
     (optionally quoted) token is the trigger and the rest is the inline reply. */
  const { first, rest } = quoted ? { first: stripQuotes(body), rest: "" } : splitQuotedArg(body);

  if (!first) {
    return m.reply(
      `*Tambah Filter*\n\nUsage: \`${prefix}filter add [grup] <pemicu> <balasan>\`\nPola ber-spasi: \`${prefix}filter add "re:^halo dunia$" Hai juga!\`\nAtau balas pesan: \`${prefix}filter add [grup] <pemicu>\``,
    );
  }

  const target = globalScope
    ? { jid: GLOBAL_SCOPE, alias: GLOBAL_KEYWORD, registration: null }
    : await resolveDataTarget(m, ctx, { args: targetArg ? [targetArg] : [] });
  if (target.error) return m.reply(target.error);

  /* global filters apply to every group — restrict to the owner (whitelist in PC) */
  if (globalScope && !isOwnerOrWhitelistedIn(m)) {
    return m.reply(`*Hanya owner* yang boleh menyimpan filter \`${GLOBAL_KEYWORD}\`.`);
  }

  /* save gate applies to the target group (skipped for global) */
  if (!globalScope) {
    const group = db.getGroup(target.jid) || {};
    const mode = group.allowSaveNote || "all";
    const isManager = m.isOwner || isOwnerOrWhitelistedIn(m) || (m.isGroup && m.chat === target.jid && isGroupAdmin(m));
    if (mode === "admin" && !isManager) {
      return m.reply("*Hanya admin* yang boleh menyimpan filter di grup ini.");
    }
  }

  const error = validateEntry(first);
  if (error) return m.reply(`Gagal: ${error}`);

  const scope = globalScope ? GLOBAL_SCOPE : resolveScopeId("filters", target.jid);
  const key = normalizeEntry(first);

  if (rest) {
    db.setFilter(scope, key, { content: rest, createdBy: m.sender });
    return m.reply(`Filter \`${key}\` disimpan.\n\nUji dengan mengirim: \`${key}\``);
  }

  if (!quoted) {
    return m.reply(
      `*Tidak ada balasan.*\n\nTulis balasan langsung, atau balas sebuah pesan.\nContoh: \`${prefix}filter add ${key} Halo juga!\``,
    );
  }

  const mediaType = detectMediaType(quoted);
  if (!mediaType) {
    const quotedBody = quoted.body || quoted.text || "";
    if (!quotedBody) return m.reply("Pesan yang dibalas tidak punya teks/media yang didukung.");
    db.setFilter(scope, key, { content: quotedBody, createdBy: m.sender });
    return m.reply(`Filter \`${key}\` disimpan dari pesan yang dibalas.`);
  }

  if (!ALLOWED_MEDIA.has(mediaType)) {
    return m.reply(`Tipe media \`${mediaType}\` tidak didukung (hanya gambar/stiker/GIF/audio).`);
  }

  let buffer;
  try {
    buffer = await downloadMedia(quoted, sock);
  } catch {
    return m.reply("Gagal mengunduh media.");
  }
  if (!buffer) return m.reply("Media tidak dapat diunduh.");
  if (buffer.length > MAX_MEDIA_BYTES) return m.reply("Media terlalu besar (maks 10 MB).");

  db.setFilter(scope, key, {
    content: quoted.body || quoted.text || "",
    mediaType,
    mediaBase64: buffer.toString("base64"),
    mediaMimetype: getMimetype(quoted) || null,
    createdBy: m.sender,
  });
  await m.reply(`Filter media \`${key}\` disimpan (${mediaType}).`);
}

/* ─────────────────────────── del ─────────────────────────── */

/**
 * Resolve a deletion argument to a filter.
 *
 * The list is numbered, so a bare number addresses the entry at that position
 * in the SAME order the list uses — that is the documented, predictable rule.
 *
 * A trigger may itself be numeric (`add 1 …`). Quoting addresses the literal
 * trigger, so such a filter is never unreachable:
 *
 *   del 1      → the 1st entry of the list
 *   del "1"    → the filter whose trigger is literally `1`
 *
 * When the two could be confused the reply says so, so the owner is never left
 * wondering which entry a bare number removed.
 *
 * @param {Array<{trigger:string}>} filters the scope's filters
 * @param {string} arg the raw argument
 * @returns {{filter: object|null, index?: number, total: number, note?: string}}
 */
function resolveDeleteTarget(filters, arg) {
  const ordered = sortedFilters(filters);
  const total = ordered.length;
  const raw = String(arg || "").trim();
  const quoted = /^["'].*["']$/.test(raw);
  const name = quoted ? stripQuotes(raw) : raw;
  const literal = ordered.find((f) => f.trigger === name);
  const asIndex = /^\d+$/.test(name) ? Number(name) : null;

  /* a quoted (or non-numeric) argument only ever means the trigger itself */
  if (quoted) return { filter: literal || null, total };
  if (asIndex === null) return { filter: literal || null, total };

  /* the number is out of range of the list — it can only be a literal trigger,
     otherwise say the position does not exist */
  if (asIndex < 1 || asIndex > total) {
    if (literal) return { filter: literal, total };
    return { filter: null, index: asIndex, total };
  }

  const byIndex = ordered[asIndex - 1];
  /* a quoted form is the only way to name a numeric trigger, so tell the owner
     when one exists — otherwise `del N` silently looks like it should have
     matched that trigger */
  const numericTriggers = ordered.filter((f) => /^\d+$/.test(f.trigger)).map((f) => f.trigger);
  return {
    filter: byIndex,
    index: asIndex,
    total,
    note: numericTriggers.length
      ? `Angka di sini berarti nomor urut. Filter bernama angka (${numericTriggers.map((t) => `\`${t}\``).join(", ")}) dihapus dengan kutip: \`"${numericTriggers[0]}"\`.`
      : undefined,
  };
}

async function handleDel(m, ctx, args, text) {
  const { db } = ctx;
  const prefix = m.prefix || ctx.config?.command?.prefix || ".";

  let targetArg = null;
  let globalScope = false;
  let body = String(text || "").trim();
  if (args.length >= 2 && (resolveGroup(args[0]) || isGlobalTarget(args[0]))) {
    targetArg = args[0];
    globalScope = isGlobalTarget(args[0]);
    body = body.slice(targetArg.length).trim();
  }

  const { first: trigger } = splitQuotedArg(body);
  if (!trigger) {
    return m.reply(
      `*Hapus Filter*\n\nUsage: \`${prefix}filter del [grup|${GLOBAL_KEYWORD}] <nomor|pemicu>\`\n` +
        `Nomor mengikuti urutan daftar: lihat dengan \`${prefix}filter\`.`,
    );
  }

  if (globalScope && !isOwnerOrWhitelistedIn(m)) {
    return m.reply(`*Hanya owner* yang boleh menghapus filter \`${GLOBAL_KEYWORD}\`.`);
  }

  const target = globalScope
    ? { jid: GLOBAL_SCOPE, alias: GLOBAL_KEYWORD, registration: null }
    : await resolveManagedTarget(m, ctx, { args: targetArg ? [targetArg] : [] });
  if (target.error) return m.reply(target.error);

  const scope = globalScope ? GLOBAL_SCOPE : resolveScopeId("filters", target.jid);
  const resolved = resolveDeleteTarget(db.listFilters(scope), trigger);

  if (!resolved.filter) {
    if (resolved.index !== undefined) {
      return m.reply(
        `Nomor \`${resolved.index}\` di luar jangkauan — daftar berisi ${resolved.total} filter.\n` +
          `Lihat daftar: \`${prefix}filter${globalScope ? ` ${GLOBAL_KEYWORD}` : ""}\``,
      );
    }
    return m.reply(`Tidak ada filter \`${trigger}\` di grup itu.`);
  }

  const removed = db.deleteFilter(scope, resolved.filter.trigger);
  if (!removed) return m.reply(`Gagal menghapus filter \`${resolved.filter.trigger}\`.`);

  const via = resolved.index !== undefined ? ` (nomor ${resolved.index})` : "";
  await m.reply(`Filter \`${resolved.filter.trigger}\` dihapus${via}.${resolved.note ? `\n\n${resolved.note}` : ""}`);
}

/* ─────────────────────────── cd ─────────────────────────── */

function parseDuration(arg) {
  const match = /^(\d+)([smh])$/i.exec(String(arg || ""));
  if (!match) return null;
  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  if (unit === "s") return value > 60 ? null : value;
  if (unit === "m") return value > 60 ? null : value * 60;
  return value > 24 ? null : value * 3600;
}

function formatCd(seconds) {
  if (seconds % 3600 === 0 && seconds >= 3600) return `${seconds / 3600}h`;
  if (seconds % 60 === 0 && seconds >= 60) return `${seconds / 60}m`;
  return `${seconds}s`;
}

async function handleCd(m, ctx, args) {
  const prefix = m.prefix || ctx.config?.command?.prefix || ".";

  /* the duration is the token that parses; anything before it is the target */
  let seconds = null;
  let targetArg = null;
  for (let i = args.length - 1; i >= 0; i--) {
    const parsed = parseDuration(args[i]);
    if (parsed !== null) {
      seconds = parsed;
      targetArg = args[i - 1] || null;
      break;
    }
  }
  if (seconds === null && args.length) targetArg = args[args.length - 1];

  const target = await resolveManagedTarget(m, ctx, { args: targetArg ? [targetArg] : [] });
  if (target.error) return m.reply(target.error);

  const label = target.alias || target.jid.split("@")[0];

  if (seconds === null) {
    const current = getFilterCooldown(target.jid);
    return m.reply(`*Filter Cooldown* (${label}): ${formatCd(current)}\n\nUsage: \`${prefix}filter cd [grup] <Ns|Nm|Nh>\``);
  }

  setFilterCooldown(target.jid, seconds);
  ctx.db.setGroup(target.jid, { filterCooldownSeconds: seconds });
  await m.reply(`Filter cooldown *${label}* diset ke ${formatCd(seconds)}.`);
}

/* ─────────────────────────── dispatch ─────────────────────────── */

async function handler(m, ctx) {
  const invoked = String(m.command || "filter").toLowerCase();
  const args = m.args || [];
  const text = String(m.text || "").trim();

  if (LIST_ALIASES.includes(invoked)) return handleList(m, ctx, args[0]);
  if (ADD_ALIASES.includes(invoked)) return handleAdd(m, ctx, args, text);
  if (DEL_ALIASES.includes(invoked)) return handleDel(m, ctx, args, text);
  if (CD_ALIASES.includes(invoked)) return handleCd(m, ctx, args);

  /* primary: `.filter <sub>` (defaults to list) */
  const sub = (args[0] || "").toLowerCase();
  const rest = args.slice(1);
  const restText = sub ? text.slice(args[0].length).trim() : text;

  if (sub === "add" || sub === "set" || sub === "tambah") return handleAdd(m, ctx, rest, restText);
  if (sub === "del" || sub === "delete" || sub === "remove" || sub === "hapus") return handleDel(m, ctx, rest, restText);
  if (sub === "cd" || sub === "cooldown") return handleCd(m, ctx, rest);
  if (sub === "list") return handleList(m, ctx, rest[0]);
  /* bare `.filter <grup|global|all>` behaves like the legacy `.filters` list,
     but `.filter <grup|global> <pemicu> <balasan>` (extra args) adds a filter */
  if (args.length >= 2 && (resolveGroup(sub) || isGlobalTarget(sub))) return handleAdd(m, ctx, args, text);
  return handleList(m, ctx, args[0]);
}

export { pluginConfig as config, handler };
