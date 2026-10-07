/**
 * GX-ID — /link (owner/whitelist)
 *
 * Links groups together. Three forms:
 *
 *   .link <grup>                  → this chat manages <grup> (control panel)
 *   .link <grup-a> <grup-b>       → peer link (either may manage the other)
 *   .link <fitur> <grup-a> <grup-b> → FEATURE link: share that feature's data
 *                                     (`notes`, `filters`, `blacklist`, `schedule`).
 *
 * Every argument may be an alias, a bare internal id, or a full JID.
 */
import { resolveGroup, NOT_REGISTERED_MESSAGE, ALIAS_NOT_FOUND_MESSAGE } from "../../lib/group-registry.js";
import { isScopeFeature } from "../../lib/group-scope.js";

const pluginConfig = {
  name: "link",
  alias: ["hubungkan", "tautkan"],
  category: "group-setup",
  description: "Hubungkan grup (manajemen, sesama grup, atau per-fitur)",
  usage: ".link <grup>  |  .link <grup-a> <grup-b>  |  .link <notes|filters|blacklist|schedule> <grup-a> <grup-b>",
  examples: [".link kelas-a", ".link kelas-a kelas-b", ".link notes kelas-a kelas-b"],
  permission: "owner",
  cooldown: 3,
  isEnabled: true,
};

function requireActive(resolved) {
  if (!resolved) return null;
  if (resolved.registration.status !== "active") return { error: NOT_REGISTERED_MESSAGE };
  return resolved;
}

async function handler(m, { db, config }) {
  const prefix = m.prefix || config.command?.prefix || ".";
  const args = m.args || [];
  if (!args.length) {
    return m.reply(
      `🔗 *Link*\n\n` +
        `> \`${prefix}link <grup>\` — kelola grup dari chat ini\n` +
        `> \`${prefix}link <grup-a> <grup-b>\` — hubungkan dua grup\n` +
        `> \`${prefix}link notes <a> <b>\` — bagikan catatan\n` +
        `> \`${prefix}link filters <a> <b>\` — bagikan filter\n` +
        `> \`${prefix}link blacklist <a> <b>\` — bagikan blacklist\n` +
        `> \`${prefix}link schedule <a> <b>\` — bagikan jadwal\n\n` +
        `> Grup bisa berupa alias atau id. Lihat: \`${prefix}listreg\``,
    );
  }

  /* ── feature-scoped link: .link <feature> <a> <b> ── */
  if (args.length >= 3 && isScopeFeature(args[0])) {
    const feature = args[0].toLowerCase();
    const a = resolveGroup(args[1]);
    const b = resolveGroup(args[2]);
    if (!a || !b) return m.reply(NOT_REGISTERED_MESSAGE);
    if (a.groupId === b.groupId) return m.reply("❌ Tidak bisa menghubungkan grup ke dirinya sendiri.");

    let scope = db.findScopeFor(feature, a.groupId) || db.findScopeFor(feature, b.groupId);
    if (!scope) {
      scope = db.createScope(feature, [a.groupId, b.groupId]);
    } else {
      db.addGroupToScope(scope.id, a.groupId);
      db.addGroupToScope(scope.id, b.groupId);
      scope = db.getScope(scope.id);
    }
    const label = a.alias || a.groupId.split("@")[0];
    const label2 = b.alias || b.groupId.split("@")[0];
    await m.reply(
      `✅ *${feature} dibagikan.*\n\n> \`${label}\` ⇄ \`${label2}\`\n> Grup dalam scope: ${scope?.groups.length ?? 2}`,
    );
    return;
  }

  /* ── peer link: .link <a> <b> ── */
  if (args.length >= 2) {
    const a = resolveGroup(args[0]);
    const b = resolveGroup(args[1]);
    if (!a || !b) return m.reply(NOT_REGISTERED_MESSAGE);
    if (a.groupId === b.groupId) return m.reply("❌ Tidak bisa menghubungkan grup ke dirinya sendiri.");
    const active = requireActive(a) || requireActive(b);
    if (active?.error) return m.reply(active.error);

    db.linkGroup(a.groupId, b.groupId);
    db.linkGroup(b.groupId, a.groupId);
    const la = a.alias || a.groupId.split("@")[0];
    const lb = b.alias || b.groupId.split("@")[0];
    await m.reply(`✅ Grup *${la}* ⇄ *${lb}* terhubung.`);
    return;
  }

  /* ── single target: this chat manages <grup> ── */
  const target = resolveGroup(args[0]);
  if (!target) return m.reply(ALIAS_NOT_FOUND_MESSAGE);
  if (target.groupId === m.chat) return m.reply("❌ Tidak bisa menghubungkan grup ke dirinya sendiri.");
  if (target.registration.status !== "active") return m.reply(NOT_REGISTERED_MESSAGE);

  db.linkGroup(m.chat, target.groupId);
  const label = target.alias || target.groupId.split("@")[0];
  await m.reply(
    `✅ Grup *${target.registration.name || label}* terhubung.\n\n> Pakai \`${label}\` sebagai target di perintah mana pun.`,
  );
}

export { pluginConfig as config, handler };
