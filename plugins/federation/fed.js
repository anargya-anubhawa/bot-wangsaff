/**
 * GX-ID — /fed (owner)
 *
 * Unified federation command, merging the former `fed` (list/info),
 * `fedcreate`, `fedjoin` and `fedleave` plugins. Every original entry point is
 * preserved as an alias, so existing usages keep working, while the unified
 * interface is parameter driven:
 *
 *   .fed                          → list every federation
 *   .fed list                     → same as above
 *   .fed info [fed]               → stats for a federation (id / alias / name)
 *   .fed create <nama> [| alias]  → create a federation & join THIS group
 *   .fed join <fed> [grup]        → join a group (default: THIS group) to <fed>
 *   .fed leave [fed]              → leave the federation linked to THIS group
 *
 * Aliases (back-compat): fedlist/listfed/daftarfed/listfederasi,
 * fedinfo/infofed/fedstats/statfed/statistikfed, fedcreate/newfederation/
 * buatfederasi, fedjoin/joinfederation/gabungfederasi, fedleave/leavefederation/
 * keluarfederasi.
 */
import {
  resolveFederation,
  linkedFederation,
  federationLabel,
  formatFederationList,
  formatFederationInfo,
} from "../../lib/federation.js";
import { resolveGroup, ALIAS_NOT_FOUND_MESSAGE } from "../../lib/group-registry.js";

const LIST_ALIASES = ["fedlist", "listfed", "daftarfed", "listfederasi"];
const INFO_ALIASES = ["fedinfo", "infofed", "fedstats", "statfed", "statistikfed"];
const CREATE_ALIASES = ["fedcreate", "newfederation", "buatfederasi"];
const JOIN_ALIASES = ["fedjoin", "joinfederation", "gabungfederasi"];
const LEAVE_ALIASES = ["fedleave", "leavefederation", "keluarfederasi"];

const pluginConfig = {
  name: "fed",
  alias: [...LIST_ALIASES, ...INFO_ALIASES, ...CREATE_ALIASES, ...JOIN_ALIASES, ...LEAVE_ALIASES],
  category: "federation",
  description: "Kelola federasi: daftar, info, buat, gabung, keluar",
  usage: ".fed [list|info [fed]|create <nama>|join <fed> [grup]|leave [fed]]",
  examples: [".fed list", ".fed info nusantara", ".fed create Nusantara", ".fed join nusantara", ".fed leave"],
  parameters: [
    { name: "list", description: "Tampilkan semua federasi" },
    { name: "info", description: "Statistik federasi: info [fed]" },
    { name: "create", description: "Buat federasi: create <nama> | <alias>" },
    { name: "join", description: "Gabung: join <fed> [grup]" },
    { name: "leave", description: "Keluar: leave [fed]" },
  ],
  helpOnEmpty: true,
  permission: "owner",
  cooldown: 3,
  isEnabled: true,
};

function slugify(name) {
  return String(name || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

async function showList(m, db, prefix) {
  const feds = db.listFederations();
  await m.reply(formatFederationList(feds, prefix));
}

async function showInfo(m, db, query, prefix) {
  let fed = null;
  if (query) {
    fed = resolveFederation(query);
    if (!fed) return m.reply(`❌ Federasi \`${query}\` tidak ditemukan.\n\n> Lihat daftar: \`${prefix}fed list\``);
  } else {
    fed = linkedFederation(m.chat);
    if (!fed) {
      return m.reply(
        `❌ Grup ini tidak tertaut federasi.\n\n> Sebutkan fed: \`${prefix}fed info <id|alias>\`\n> Lihat daftar: \`${prefix}fed list\``,
      );
    }
  }
  await m.reply(formatFederationInfo(fed, prefix));
}

async function handleCreate(m, db, prefix, text) {
  if (!m.isGroup) return m.reply("❌ Perintah ini hanya bisa dipakai di dalam grup.");
  const raw = String(text || "").trim();
  if (!raw) {
    return m.reply(`🤝 *Buat Federasi*\n\n> Usage: \`${prefix}fed create <nama>\`\n> Alias kustom: \`${prefix}fed create <nama> | <alias>\``);
  }

  const existing = db.getGroup(m.chat) || {};
  if (existing.federationId) {
    return m.reply(`⚠️ Grup ini sudah tergabung dalam federasi \`${existing.federationId}\`. Keluar dulu dengan \`${prefix}fed leave\`.`);
  }

  /* `<nama> | <alias>` — optional explicit alias */
  let name = raw;
  let aliasInput = "";
  const bar = raw.indexOf("|");
  if (bar !== -1) {
    name = raw.slice(0, bar).trim();
    aliasInput = raw.slice(bar + 1).trim();
  }
  if (!name) return m.reply("❌ Nama federasi tidak boleh kosong.");

  const base = slugify(name) || `fed-${Date.now().toString(36)}`;
  let id = base;
  let n = 1;
  while (db.getFederation(id)) id = `${base}-${n++}`;

  const alias = slugify(aliasInput) || base;

  db.createFederation(name, id, alias);
  db.joinFederation(id, m.chat);
  db.setGroup(m.chat, { federationId: id });

  await m.reply(
    `✅ *Federasi dibuat.*\n\n> Nama: *${name}*\n> Alias: \`${alias}\`\n> ID: \`${id}\`\n> Grup ini tergabung.\n\n> Gabungkan grup lain: \`${prefix}fed join ${alias}\``,
  );
}

async function handleJoin(m, db, prefix, args) {
  if (!m.isGroup) return m.reply("❌ Perintah ini hanya bisa dipakai di dalam grup.");
  const query = (args[0] || "").trim();
  if (!query) {
    return m.reply(
      `🤝 *Join Federasi*\n\n> Usage: \`${prefix}fed join <id|alias fed> [grup]\`\n> Tanpa grup: grup ini yang digabungkan.`,
    );
  }

  const federation = resolveFederation(query);
  if (!federation) {
    return m.reply(`❌ Federasi \`${query}\` tidak ditemukan.\n\n> Lihat daftar: \`${prefix}fed list\``);
  }

  /* Target group: the second arg (alias/id) or the current group. */
  let targetJid = m.chat;
  if (args[1]) {
    const resolved = resolveGroup(args[1]);
    if (!resolved) return m.reply(ALIAS_NOT_FOUND_MESSAGE);
    targetJid = resolved.groupId;
  }

  const group = db.getGroup(targetJid) || {};
  if (group.federationId === federation.id) {
    return m.reply(`⚠️ Grup itu sudah tergabung di federasi *${federationLabel(federation)}*.`);
  }
  if (group.federationId && group.federationId !== federation.id) {
    db.leaveFederation(group.federationId, targetJid);
  }

  db.joinFederation(federation.id, targetJid);
  db.setGroup(targetJid, { federationId: federation.id });
  const count = (db.getFederation(federation.id)?.groups || []).length;
  const label = targetJid === m.chat ? "Grup ini" : `Grup \`${String(targetJid).split("@")[0]}\``;

  await m.reply(`✅ ${label} bergabung ke federasi *${federationLabel(federation)}*.\n> Total grup: ${count}`);
}

async function handleLeave(m, db, prefix, args) {
  if (!m.isGroup) return m.reply("❌ Perintah ini hanya bisa dipakai di dalam grup.");
  const query = (args[0] || "").trim();

  const group = db.getGroup(m.chat) || {};
  const id = query ? resolveFederation(query)?.id : group.federationId;

  if (!id) {
    return m.reply(
      query
        ? `❌ Federasi \`${query}\` tidak ditemukan.\n\n> Lihat daftar: \`${prefix}fed list\``
        : "⚠️ Grup ini tidak tergabung dalam federasi mana pun.",
    );
  }
  if (group.federationId !== id) {
    return m.reply("⚠️ Grup ini tidak tergabung di federasi tersebut.");
  }

  const fed = db.getFederation(id);
  db.leaveFederation(id, m.chat);
  db.setGroup(m.chat, { federationId: null });
  const remaining = db.getFederation(id);
  await m.reply(
    `✅ Grup ini keluar dari federasi *${federationLabel(fed)}*.\n> Sisa anggota: ${(remaining?.groups || []).length} grup.`,
  );
}

async function handler(m, ctx) {
  const { db, config } = ctx;
  const prefix = m.prefix || config.command?.prefix || ".";
  const args = m.args || [];
  const invoked = String(m.command || "fed").toLowerCase();
  const text = String(m.text || "").trim();

  if (INFO_ALIASES.includes(invoked)) {
    return showInfo(m, db, args.join(" ").trim(), prefix);
  }
  if (LIST_ALIASES.includes(invoked)) {
    return showList(m, db, prefix);
  }
  if (CREATE_ALIASES.includes(invoked)) {
    return handleCreate(m, db, prefix, text);
  }
  if (JOIN_ALIASES.includes(invoked)) {
    return handleJoin(m, db, prefix, args);
  }
  if (LEAVE_ALIASES.includes(invoked)) {
    return handleLeave(m, db, prefix, args);
  }

  /* primary: `.fed <sub>` */
  const sub = (args[0] || "").toLowerCase();
  if (sub === "create" || sub === "buat") {
    return handleCreate(m, db, prefix, text.slice(args[0].length).trim());
  }
  if (sub === "join" || sub === "gabung") {
    return handleJoin(m, db, prefix, args.slice(1));
  }
  if (sub === "leave" || sub === "keluar") {
    return handleLeave(m, db, prefix, args.slice(1));
  }
  if (sub === "info" || sub === "stats") {
    return showInfo(m, db, args.slice(1).join(" ").trim(), prefix);
  }

  /* `.fed`, `.fed list` */
  return showList(m, db, prefix);
}

export { pluginConfig as config, handler };
