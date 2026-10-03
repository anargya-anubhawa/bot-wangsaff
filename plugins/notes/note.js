/**
 * GX-ID — /note
 *
 * Unified note command, merging the former `addnote`, `delnote`, `notes` and
 * `allowsavenote` plugins. Every original entry point is preserved as an alias,
 * so existing usages keep working, while the unified interface is parameter
 * driven:
 *
 *   .note [grup|global|all]                 → list notes (plain text)
 *   .note add [grup|global] <nama> <isi>    → save a note (text/media)
 *   .note del [grup|global] <nama>          → delete a note
 *   .note mode [grup] <admin|all>           → who may save notes/filters
 *
 * A note is text or media saved for a group scope; notes may be shared between
 * linked groups (`.link notes <a> <b>`), and a `global` note is visible in every
 * registered group. Read a note with `#nama` or `.getnote <nama>`.
 *
 * Aliases (back-compat): addnote/savenote/setnote, delnote/removenote/
 * deletenote, notes/listnote/notelist/catatan, allowsavenote/savenotemode/
 * izinkancatatan.
 */
import { isOwnerOrWhitelistedIn, isGroupAdmin } from "../../lib/access.js";
import { detectMediaType, getMimetype, downloadMedia } from "../../lib/media.js";
import { resolveGroup, resolveDataTarget, resolveManagedTarget } from "../../lib/group-registry.js";
import { resolveScopeId, listEffectiveNotes, isGlobalTarget, GLOBAL_SCOPE, GLOBAL_KEYWORD } from "../../lib/group-scope.js";

const MAX_NOTE_MEDIA_BYTES = 10 * 1024 * 1024;
const ALLOWED_MEDIA = new Set(["image", "audio", "sticker"]);

const ADD_ALIASES = ["addnote", "savenote", "setnote"];
const DEL_ALIASES = ["delnote", "removenote", "deletenote"];
const LIST_ALIASES = ["notes", "listnote", "notelist", "catatan"];
const MODE_ALIASES = ["allowsavenote", "savenotemode", "izinkancatatan"];

const pluginConfig = {
  name: "note",
  alias: [...ADD_ALIASES, ...DEL_ALIASES, ...LIST_ALIASES, ...MODE_ALIASES],
  category: "notes",
  description: "Kelola catatan sebuah grup: daftar, simpan, hapus, izin simpan",
  usage: ".note [list|add|del|mode] ...",
  examples: [".note", ".note add rules Bersikap baiklah!", ".note del rules", ".note mode admin"],
  parameters: [
    { name: "list", description: "Tampilkan catatan (default)" },
    { name: "add", description: "Simpan: add [grup|global] <nama> <isi>" },
    { name: "del", description: "Hapus: del [grup|global] <nama>" },
    { name: "mode", description: "Izin simpan: mode [grup] <admin|all>" },
    { name: "grup", description: "Target grup (alias/id)" },
    { name: "global", description: "Scope global (owner)" },
    { name: "all", description: "Lihat semua grup (owner)" },
  ],
  helpOnEmpty: true,
  permission: "all",
  cooldown: 3,
  isEnabled: true,
};

function formatMb(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* ─────────────────────────── add ─────────────────────────── */

async function handleAdd(m, ctx, args, text) {
  const { db, sock, config } = ctx;
  const prefix = m.prefix || config.command?.prefix || ".";

  /* target may lead: `.note add <grup|global> <nama> ...` */
  let targetArg = null;
  let globalScope = false;
  let name;
  if (args.length >= 2 && (resolveGroup(args[0]) || isGlobalTarget(args[0]))) {
    targetArg = args[0];
    globalScope = isGlobalTarget(args[0]);
    name = (args[1] || "").toLowerCase();
  } else {
    name = (args[0] || "").toLowerCase();
  }

  if (!name) {
    return m.reply(
      `📝 *Simpan Catatan*\n\n> Usage: \`${prefix}note add [grup|global] <nama> <isi>\`\n> Atau balas pesan: \`${prefix}note add <nama>\`\n> Contoh: \`${prefix}note add rules Bersikap baik!\`\n> Global (semua grup terdaftar): \`${prefix}note add ${GLOBAL_KEYWORD} rules Bersikap baik!\``,
    );
  }
  if (!/^[a-zA-Z0-9_\-.]+$/.test(name)) {
    return m.reply("⚠️ Nama catatan hanya boleh berisi huruf, angka, `_`, `-`, `.`");
  }

  /* global notes affect every group — restrict to the owner (whitelist in PC) */
  if (globalScope && !isOwnerOrWhitelistedIn(m)) {
    return m.reply(`🔒 *Hanya owner* yang boleh menyimpan catatan \`${GLOBAL_KEYWORD}\`.`);
  }

  const target = globalScope
    ? { jid: GLOBAL_SCOPE, alias: GLOBAL_KEYWORD, registration: null }
    : await resolveDataTarget(m, ctx, { args: targetArg ? [targetArg] : [] });
  if (target.error) return m.reply(target.error);

  /* per-group save gate (applies to the target group, skipped for global) */
  if (!globalScope) {
    const group = db.getGroup(target.jid) || {};
    const mode = group.allowSaveNote || "all";
    const isManager = m.isOwner || isOwnerOrWhitelistedIn(m) || (m.isGroup && m.chat === target.jid && isGroupAdmin(m));
    if (mode === "admin" && !isManager) {
      return m.reply("🔒 *Hanya admin* yang boleh menyimpan catatan di grup ini.");
    }
  }

  const scope = globalScope ? GLOBAL_SCOPE : resolveScopeId("notes", target.jid);
  const existing = db.getNote(scope, name);

  /* inline text: everything after the (optional) target + name tokens */
  let rest = String(text || "");
  if (targetArg) rest = rest.slice(targetArg.length).trim();
  const inline = rest.slice(name.length).trim();

  if (inline) {
    db.setNote(scope, name, inline, m.sender);
    return m.reply(`${existing ? "♻️ *Note updated.*" : "✅ *Note saved.*"}\n\n> Name: \`${name}\`\n> View: \`#${name}\``);
  }

  const quoted = m.quoted;
  if (!quoted) {
    return m.reply(
      `❌ *Tidak ada konten.*\n\n> Balas sebuah pesan (teks/gambar/stiker/GIF/audio), atau tulis isi catatan langsung.\n> Contoh: \`${prefix}note add ${name} isi catatan\``,
    );
  }

  const mediaType = detectMediaType(quoted);
  if (!mediaType) {
    const quotedText = quoted.body || quoted.text || "";
    if (!quotedText) return m.reply("❌ Pesan yang dibalas tidak memiliki teks atau media yang didukung.");
    db.setNote(scope, name, quotedText, m.sender);
    return m.reply(`✅ *Catatan disimpan dari pesan yang dibalas.*\n\n> Nama: \`${name}\`\n> Lihat: \`#${name}\``);
  }

  if (!ALLOWED_MEDIA.has(mediaType)) {
    return m.reply(`❌ *Tipe media tidak didukung:* ${mediaType}.\n\n> Hanya gambar, stiker, GIF, atau audio yang dapat disimpan.`);
  }

  let buffer;
  try {
    buffer = await downloadMedia(quoted, sock);
  } catch {
    return m.reply("❌ Gagal mengunduh media tersebut. Coba lagi.");
  }
  if (!buffer) return m.reply("❌ Media tidak dapat diunduh.");
  if (buffer.length > MAX_NOTE_MEDIA_BYTES) {
    return m.reply(`❌ Media terlalu besar (${formatMb(buffer.length)}). Maksimum ${formatMb(MAX_NOTE_MEDIA_BYTES)}.`);
  }

  db.setRichNote(scope, name, {
    content: quoted.body || quoted.text || "",
    mediaType,
    mediaBase64: buffer.toString("base64"),
    mediaMimetype: getMimetype(quoted) || undefined,
    createdBy: m.sender,
  });

  await m.reply(`✅ *Catatan media disimpan.*\n\n> Nama: \`${name}\`\n> Tipe: ${mediaType}\n> Lihat: \`#${name}\``);
}

/* ─────────────────────────── del ─────────────────────────── */

async function handleDel(m, ctx, args) {
  const { db, config } = ctx;
  const prefix = m.prefix || config.command?.prefix || ".";

  let targetArg = null;
  let globalScope = false;
  let name;
  if (args.length >= 2 && (resolveGroup(args[0]) || isGlobalTarget(args[0]))) {
    targetArg = args[0];
    globalScope = isGlobalTarget(args[0]);
    name = (args[1] || "").toLowerCase();
  } else {
    name = (args[0] || "").toLowerCase();
  }

  if (!name) {
    return m.reply(`📝 *Hapus Catatan*\n\n> Usage: \`${prefix}note del [grup|${GLOBAL_KEYWORD}] <nama>\``);
  }

  if (globalScope && !isOwnerOrWhitelistedIn(m)) {
    return m.reply(`🔒 *Hanya owner* yang boleh menghapus catatan \`${GLOBAL_KEYWORD}\`.`);
  }

  const target = globalScope
    ? { jid: GLOBAL_SCOPE, alias: GLOBAL_KEYWORD, registration: null }
    : await resolveDataTarget(m, ctx, { args: targetArg ? [targetArg] : [] });
  if (target.error) return m.reply(target.error);

  const scope = globalScope ? GLOBAL_SCOPE : resolveScopeId("notes", target.jid);
  const deleted = db.deleteNote(scope, name);
  if (!deleted) return m.reply(`❓ Tidak ada catatan bernama \`${name}\` di grup itu.`);
  await m.reply(`🗑️ *Catatan dihapus.*\n\n> Nama: \`${name}\``);
}

/* ─────────────────────────── list ─────────────────────────── */

function renderNotes(title, notes) {
  const lines = notes
    .map((n, i) => {
      const tag = n.mediaType ? ` _(${n.mediaType})_` : "";
      return `┃ ${i + 1}. \`#${n.name}\`${tag}`;
    })
    .join("\n");
  return `📝 *${title} (${notes.length})*\n\n╭─〔 notes 〕\n${lines}\n╰─⬣`;
}

async function handleList(m, ctx, arg) {
  const { db } = ctx;
  const prefix = m.prefix || ctx.config?.command?.prefix || ".";

  /* .note all — every registered group, grouped per group (owner only) */
  if (String(arg || "").toLowerCase() === "all") {
    if (!m.isOwner) {
      return m.reply("🔒 *Hanya owner* yang boleh melihat catatan semua grup.");
    }
    const sections = [];
    const globals = db.listNotes(GLOBAL_SCOPE).sort((a, b) => a.name.localeCompare(b.name));
    if (globals.length) sections.push(`🌐 *${GLOBAL_KEYWORD.toUpperCase()}* (${globals.length})\n${globals.map((n) => `┃ \`#${n.name}\``).join("\n")}`);
    const seenScopes = new Set([GLOBAL_SCOPE]);
    for (const reg of db.listRegistrations()) {
      const scopeId = resolveScopeId("notes", reg.jid);
      if (seenScopes.has(scopeId)) continue;
      const notes = db.listNotes(scopeId).sort((a, b) => a.name.localeCompare(b.name));
      if (!notes.length) continue;
      seenScopes.add(scopeId);
      const label = reg.alias || String(reg.jid).split("@")[0];
      sections.push(`📁 *${label}* (${notes.length})\n${notes.map((n) => `┃ \`#${n.name}\``).join("\n")}`);
    }
    if (!sections.length) {
      return m.reply("📝 *Belum ada catatan di grup mana pun.*");
    }
    return m.reply(`📝 *Semua Catatan*\n\n${sections.join("\n\n")}\n\n> Lihat: \`#nama\` atau \`${prefix}getnote <grup> <nama>\``);
  }

  /* .note global — the shared global scope only */
  if (isGlobalTarget(arg)) {
    const notes = db.listNotes(GLOBAL_SCOPE).sort((a, b) => a.name.localeCompare(b.name));
    if (!notes.length) {
      return m.reply(`📝 *Belum ada catatan ${GLOBAL_KEYWORD}.*\n\n> Simpan: \`${prefix}note add ${GLOBAL_KEYWORD} <nama> <isi>\``);
    }
    return m.reply(`${renderNotes(`Catatan ${GLOBAL_KEYWORD}`, notes)}\n\n> Lihat: \`#nama\``);
  }

  /* single group (alias/id or the current chat) — own notes + global overlay */
  const target = await resolveDataTarget(m, ctx, { args: arg ? [arg] : [] });
  if (target.error) return m.reply(target.error);

  const notes = listEffectiveNotes(db, target.jid).sort((a, b) => a.name.localeCompare(b.name));
  if (!notes.length) {
    return m.reply(`📝 *Belum ada catatan.*\n\n> Simpan dengan \`${prefix}note add <nama> <isi>\``);
  }
  const reg = db.getRegistration(target.jid);
  const label = arg ? reg?.alias || String(target.jid).split("@")[0] : "Catatan";
  await m.reply(`${renderNotes(label, notes)}\n\n> Lihat: \`#nama\` atau \`${prefix}getnote <nama>\``);
}

/* ─────────────────────────── mode ─────────────────────────── */

async function handleMode(m, ctx, args) {
  const { db, config } = ctx;
  const prefix = m.prefix || config.command?.prefix || ".";

  /* the mode is the last token that is `admin`/`all`; anything before is target */
  let mode = null;
  let targetArg = null;
  for (let i = args.length - 1; i >= 0; i--) {
    const value = String(args[i] || "").toLowerCase();
    if (value === "admin" || value === "all") {
      mode = value;
      targetArg = args[i - 1] || null;
      break;
    }
  }
  if (mode === null && args.length) targetArg = args[args.length - 1];

  const target = await resolveManagedTarget(m, ctx, { args: targetArg ? [targetArg] : [] });
  if (target.error) return m.reply(target.error);
  const label = target.alias || target.jid.split("@")[0];

  if (mode === null) {
    const current = (db.getGroup(target.jid) || {}).allowSaveNote || "all";
    return m.reply(
      `📝 *Allow Save Note* (${label})\n\n> Saat ini: *${current}*\n> Usage: \`${prefix}note mode [grup] <admin|all>\``,
    );
  }

  db.setGroup(target.jid, { allowSaveNote: mode });
  await m.reply(`✅ \`addnote\`/\`addfilter\` untuk *${label}* sekarang bisa dipakai oleh: *${mode}*.`);
}

/* ─────────────────────────── dispatch ─────────────────────────── */

async function handler(m, ctx) {
  const invoked = String(m.command || "note").toLowerCase();
  const args = m.args || [];
  const text = String(m.text || "").trim();

  if (ADD_ALIASES.includes(invoked)) return handleAdd(m, ctx, args, text);
  if (DEL_ALIASES.includes(invoked)) return handleDel(m, ctx, args);
  if (LIST_ALIASES.includes(invoked)) return handleList(m, ctx, args[0]);
  if (MODE_ALIASES.includes(invoked)) return handleMode(m, ctx, args);

  /* primary: `.note <sub>` (defaults to list) */
  const sub = (args[0] || "").toLowerCase();
  const rest = args.slice(1);
  const restText = sub ? text.slice(args[0].length).trim() : text;

  if (sub === "add" || sub === "set" || sub === "save" || sub === "tambah") return handleAdd(m, ctx, rest, restText);
  if (sub === "del" || sub === "delete" || sub === "remove" || sub === "hapus") return handleDel(m, ctx, rest);
  if (sub === "list") return handleList(m, ctx, rest[0]);
  if (sub === "mode" || sub === "allow" || sub === "allow-save") return handleMode(m, ctx, rest);
  /* bare `.note <grup|global> <nama> <isi>` (legacy shape) adds a note */
  if (args.length >= 3 && (resolveGroup(sub) || isGlobalTarget(sub))) return handleAdd(m, ctx, args, text);
  /* bare `.note <grup|global|all>` behaves like the legacy `.notes` list */
  return handleList(m, ctx, args[0]);
}

export { pluginConfig as config, handler };
