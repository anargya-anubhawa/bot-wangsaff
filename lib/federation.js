/**
 * GX-ID — federation helpers
 *
 * Shared resolution / stats / formatting used by the federation commands
 * (`.fed`, `.fedinfo`, `.fedjoin`, `.fban`, …) so the logic lives in one place.
 * A federation is identified by its `id` (internal slug), its `alias` (short
 * handle) or its `name` (display) — `db.findFederation` matches any of them.
 */
import { getDatabase } from "./database.js";

/** The federation id linked to a group, or null. */
export function linkedFederationId(groupJid) {
  try {
    const group = getDatabase().getGroup(groupJid) || {};
    return group.federationId || null;
  } catch {
    return null;
  }
}

/** The federation record linked to a group, or null. */
export function linkedFederation(groupJid) {
  const id = linkedFederationId(groupJid);
  return id ? getDatabase().getFederation(id) : null;
}

/** Resolve a user-supplied reference (id / alias / name) to a federation. */
export function resolveFederation(query) {
  try {
    return getDatabase().findFederation(query);
  } catch {
    return null;
  }
}

/** A short one-line label: `Name (alias)` or just `Name`. */
export function federationLabel(fed) {
  const name = fed?.name || fed?.id || "?";
  const alias = fed?.alias;
  return alias && alias !== name ? `${name} (${alias})` : `${name}`;
}

/**
 * Gather a federation's stats: identity, member groups (with alias/name) and
 * the ban list.
 */
export function federationStats(fed) {
  const db = getDatabase();
  const groups = (fed.groups || []).map((jid) => {
    const reg = db.getRegistration(jid);
    const group = db.getGroup(jid) || {};
    return {
      jid,
      alias: reg?.alias || null,
      name: reg?.name || group.name || null,
      registered: !!reg,
    };
  });
  const bans = [...(fed.bans || [])];
  return {
    id: fed.id,
    alias: fed.alias || fed.id,
    name: fed.name || fed.id,
    createdAt: fed.createdAt || null,
    groupCount: groups.length,
    banCount: bans.length,
    groups,
    bans,
  };
}

/** Plain-text list of every federation (id, alias, name, groups, bans). */
export function formatFederationList(feds, prefix = ".") {
  if (!feds.length) {
    return `🤝 *Federasi*\n\n> Belum ada federasi.\n\n> Buat: \`${prefix}fedcreate <nama>\``;
  }
  const lines = feds.map((fed) => {
    const s = federationStats(fed);
    return (
      `├─ *${s.name}*\n` +
      `│  ├─ Alias: \`${s.alias}\`\n` +
      `│  ├─ ID: \`${s.id}\`\n` +
      `│  ├─ Grup: ${s.groupCount}\n` +
      `│  └─ Ban: ${s.banCount}`
    );
  });
  return (
    `╭─「 DAFTAR FEDERASI 」\n│\n${lines.join("\n│\n")}\n│\n╰────────────\n\n` +
    `> Detail: \`${prefix}fedinfo <id|alias>\``
  );
}

/** Plain-text detail card for one federation. */
export function formatFederationInfo(fed, prefix = ".", { maxBans = 20 } = {}) {
  const s = federationStats(fed);
  const groupLines = s.groups.length
    ? s.groups
        .map((g) => `├─ ${g.alias || g.name || String(g.jid).split("@")[0]}${g.registered ? "" : " _(belum terdaftar)_"}`)
        .join("\n")
    : "> (kosong)";

  const shownBans = s.bans.slice(0, maxBans);
  const banLines = shownBans.length
    ? shownBans.map((num, i) => `${i + 1}. @${num}`).join("\n")
    : "> (kosong)";
  const moreBans = s.banCount > shownBans.length ? `\n> … dan ${s.banCount - shownBans.length} lainnya` : "";

  const created = s.createdAt ? `> Dibuat : ${String(s.createdAt).slice(0, 10)}\n` : "";
  return (
    `🤝 *Info Federasi*\n\n` +
    `> Nama   : *${s.name}*\n` +
    `> Alias  : \`${s.alias}\`\n` +
    `> ID     : \`${s.id}\`\n` +
    `> Grup   : ${s.groupCount}\n` +
    `> Ban    : ${s.banCount}\n` +
    created +
    `\n*Grup anggota:*\n${groupLines}\n\n` +
    `*Ban list:*\n${banLines}${moreBans}\n\n` +
    `> Ban: \`${prefix}fban <id|alias> <nomor>\`  |  Unban: \`${prefix}fban unban <id|alias> <nomor>\``
  );
}
