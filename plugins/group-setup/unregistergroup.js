/**
 * GX-ID — /unregistergroup (owner/whitelist)
 *
 * Inverse of `registergroup`: deactivates a group and removes every management
 * link pointing at it. Without an argument it acts on the current group; with
 * an alias or id it acts on that group.
 */
import { resolveGroup, ALIAS_NOT_FOUND_MESSAGE } from "../../lib/group-registry.js";
import { idCodeBlock } from "../../lib/group-id.js";

const pluginConfig = {
  name: "unregistergroup",
  alias: ["unregistergc", "nonaktifkangrup", "unregister"],
  category: "group-setup",
  description: "Nonaktifkan grup ini (kebalikan dari registergroup)",
  usage: ".unregistergroup [alias|id grup]",
  examples: [".unregistergroup", ".unregistergroup kelas-a"],
  permission: "owner",
  cooldown: 3,
  isEnabled: true,
};

async function handler(m, { db, config }) {
  const prefix = m.prefix || config.command?.prefix || ".";
  const idArg = m.args?.[0];

  let jid = m.chat;
  if (idArg) {
    const resolved = resolveGroup(idArg);
    if (!resolved) return m.reply(ALIAS_NOT_FOUND_MESSAGE);
    jid = resolved.groupId;
  } else if (!m.isGroup) {
    return m.reply(`❌ Sebutkan grup target dari luar grup.\n\n> Contoh: \`${prefix}unregistergroup kelas-a\``);
  }

  const reg = db.getRegistration(jid);
  if (!reg || reg.status !== "active") {
    return m.reply("⚠️ Grup ini memang belum terdaftar/aktif.");
  }

  db.unregisterGroup(jid);
  db.setGroup(jid, { registered: false });

  // Drop every incoming management link (a control panel loses this target).
  let removed = 0;
  for (const managementJid of db.getManagementGroupsForTarget(jid)) {
    if (db.unlinkGroup(managementJid, jid)) removed++;
  }

  await m.reply(
    `✅ *Grup dinonaktifkan.*\n\n> Nama: *${reg.name || "-"}*\n> ID: ${idCodeBlock(jid)}` +
      (removed ? `\n> ${removed} tautan manajemen dihapus.` : ""),
  );
}

export { pluginConfig as config, handler };
