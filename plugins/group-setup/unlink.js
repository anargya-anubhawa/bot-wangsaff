/**
 * GX-ID — /unlink (owner/whitelist)
 *
 * Removes a link. Mirrors `/link`:
 *
 *   .unlink <grup>                        → stop managing <grup> from here
 *   .unlink <grup-a> <grup-b>             → break the peer link
 *   .unlink <notes|filters|blacklist> <a> <b> → stop sharing that feature
 */
import { resolveGroup, NOT_REGISTERED_MESSAGE, ALIAS_NOT_FOUND_MESSAGE } from "../../lib/group-registry.js";
import { isScopeFeature } from "../../lib/group-scope.js";

const pluginConfig = {
  name: "unlink",
  alias: ["unlinkgroup", "putushubungan"],
  category: "group-setup",
  description: "Hapus tautan grup (manajemen, sesama grup, atau per-fitur)",
  usage: ".unlink <grup>  |  .unlink <grup-a> <grup-b>  |  .unlink <fitur> <a> <b>",
  examples: [".unlink kelas-a", ".unlink kelas-a kelas-b", ".unlink notes kelas-a kelas-b"],
  permission: "owner",
  cooldown: 3,
  isEnabled: true,
};

async function handler(m, { db, config }) {
  const prefix = m.prefix || config.command?.prefix || ".";
  const args = m.args || [];
  if (!args.length) {
    return m.reply(`🔗 *Unlink*\n\n> Usage: \`${prefix}unlink <grup>\` atau \`${prefix}unlink <a> <b>\``);
  }

  /* ── feature-scoped unlink ── */
  if (args.length >= 3 && isScopeFeature(args[0])) {
    const feature = args[0].toLowerCase();
    const a = resolveGroup(args[1]);
    const b = resolveGroup(args[2]);
    if (!a || !b) return m.reply(`❌ ${NOT_REGISTERED_MESSAGE}`);
    const scope = db.findScopeFor(feature, a.groupId);
    if (!scope || !scope.groups.includes(b.groupId)) {
      return m.reply("⚠️ Kedua grup itu memang belum berbagi fitur tersebut.");
    }
    db.removeGroupFromScope(scope.id, b.groupId);
    await m.reply(`✅ *${feature}* tidak lagi dibagikan ke \`${b.alias || b.groupId.split("@")[0]}\`.`);
    return;
  }

  /* ── peer unlink ── */
  if (args.length >= 2) {
    const a = resolveGroup(args[0]);
    const b = resolveGroup(args[1]);
    if (!a || !b) return m.reply(`❌ ${NOT_REGISTERED_MESSAGE}`);
    const r1 = db.unlinkGroup(a.groupId, b.groupId);
    const r2 = db.unlinkGroup(b.groupId, a.groupId);
    if (!r1 && !r2) return m.reply("⚠️ Kedua grup itu memang belum terhubung.");
    await m.reply(`✅ Tautan \`${a.alias || a.groupId.split("@")[0]}\` ⇄ \`${b.alias || b.groupId.split("@")[0]}\` dihapus.`);
    return;
  }

  /* ── single: stop managing the target ── */
  const target = resolveGroup(args[0]);
  if (!target) return m.reply(ALIAS_NOT_FOUND_MESSAGE);
  const removed = db.unlinkGroup(m.chat, target.groupId);
  if (!removed) return m.reply("⚠️ Grup itu memang belum terhubung ke chat ini.");
  await m.reply(`✅ Grup *${target.registration.name || args[0]}* tidak lagi terhubung.`);
}

export { pluginConfig as config, handler };
