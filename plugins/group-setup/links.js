/**
 * GX-ID — /links (owner/whitelist)
 *
 * Shows a group's links as plain text (no interactive flow).
 *
 *   .links              → groups THIS chat manages (management links)
 *   .links <grup>       → groups <grup> is linked to (peer + feature sharing)
 *   .links all          → every linked group in the registry, grouped per group
 *
 * With no target outside a group the command falls back to the current chat.
 */
import { resolveGroup, ALIAS_NOT_FOUND_MESSAGE } from "../../lib/group-registry.js";
import { SCOPE_FEATURES } from "../../lib/group-scope.js";
import { idInline } from "../../lib/group-id.js";

const pluginConfig = {
  name: "links",
  alias: ["linkedgroups", "daftarlink"],
  category: "group-setup",
  description: "Tampilkan grup yang terhubung (manajemen / sesama grup / per-fitur)",
  usage: ".links [grup|all]",
  examples: [".links", ".links kelas-a", ".links all"],
  permission: "owner",
  cooldown: 3,
  isEnabled: true,
};

function resolveTargetJid(m) {
  const arg = m.args?.[0];
  if (arg) {
    const r = resolveGroup(arg);
    if (r) return r.groupId;
  }
  return m.isGroup ? m.chat : null;
}

function buildEntries(db, jid) {
  const entries = [];
  for (const target of db.getLinks(jid)) {
    const reg = db.getRegistration(target);
    entries.push({
      kind: "peer",
      jid: target,
      label: reg?.alias || String(target).split("@")[0],
      detail: `Kelola ⇄ ${reg?.name || "-"}`,
    });
  }
  for (const feature of SCOPE_FEATURES) {
    const scope = db.findScopeFor(feature, jid);
    if (!scope) continue;
    for (const g of scope.groups) {
      if (g === jid) continue;
      const reg = db.getRegistration(g);
      entries.push({
        kind: "feat",
        jid: g,
        label: reg?.alias || String(g).split("@")[0],
        detail: `berbagi ${feature}`,
      });
    }
  }
  return entries;
}

function labelOf(db, jid) {
  const reg = db.getRegistration(jid);
  return reg?.alias || String(jid).split("@")[0];
}

async function handler(m, ctx) {
  const arg = m.args?.[0];

  /* .links all — every group that has any link, grouped per group */
  if (String(arg || "").toLowerCase() === "all") {
    if (!m.isOwner) return m.reply("🔒 *Hanya owner* yang boleh melihat seluruh tautan grup.");
    const sections = [];
    const seen = new Set();
    const candidates = [...new Set([...ctx.db.listRegistrations().map((r) => r.jid), ...Object.keys(ctx.db.getAllGroups())])];
    for (const jid of candidates) {
      if (seen.has(jid)) continue;
      const entries = buildEntries(ctx.db, jid);
      if (!entries.length) continue;
      seen.add(jid);
      const lines = entries.map((e) => `┃ *${e.label}* — ${e.detail}\n┃    ${idInline(e.jid)}`).join("\n");
      sections.push(`🔗 *${labelOf(ctx.db, jid)}* (${entries.length})\n${lines}`);
    }
    if (!sections.length) return m.reply("🔗 *Belum ada grup yang terhubung.*");
    return m.reply(`🔗 *Semua Tautan Grup*\n\n${sections.join("\n\n")}`);
  }

  if (arg && !resolveGroup(arg) && !m.isGroup) {
    return m.reply(ALIAS_NOT_FOUND_MESSAGE);
  }
  const jid = resolveTargetJid(m);
  if (!jid) {
    return m.reply("🔗 *Links*\n\n> Sebutkan grup target: `.links <grup>`\n> Atau lihat semua: `.links all`");
  }

  const entries = buildEntries(ctx.db, jid);
  const label = labelOf(ctx.db, jid);
  if (!entries.length) {
    return m.reply(`🔗 *Grup terhubung — ${label}*\n\n> Belum ada grup yang terhubung.\n> Pakai \`.link <grup>\` atau \`.link notes <a> <b>\`.`);
  }

  const lines = entries.map((e, i) => `┃ ${i + 1}. *${e.label}* — ${e.detail}\n┃    ${idInline(e.jid)}`).join("\n");
  await m.reply(`🔗 *Grup terhubung — ${label}* (${entries.length})\n\n╭─〔 links 〕\n${lines}\n╰─⬣`);
}

export { pluginConfig as config, handler };
