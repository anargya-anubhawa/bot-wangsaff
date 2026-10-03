/**
 * GX-ID — /listreg (owner/whitelist)
 *
 * Lists every registered group as plain text (no interactive flow). Each entry
 * shows the alias, name, status and the id as inline code the user can tap to
 * copy. No contact-card (vCard) is sent.
 */
import { idInline } from "../../lib/group-id.js";

const pluginConfig = {
  name: "listreg",
  alias: ["listgroup", "registeredgroups", "daftargrup"],
  category: "group-setup",
  description: "Tampilkan semua grup terdaftar beserta alias & statusnya",
  usage: ".listreg",
  examples: [".listreg"],
  permission: "owner",
  cooldown: 3,
  isEnabled: true,
};

function label(db, reg) {
  const group = db.getGroup(reg.jid) || {};
  const tags = [reg.status === "active" ? "Aktif" : "Nonaktif"];
  if (group.isManagementGroup) tags.push("Manajemen");
  const management = db.getManagementGroupsForTarget(reg.jid);
  if (management.length) tags.push(`${management.length} tautan masuk`);
  return tags.join(", ");
}

function plainList(regs, db) {
  const lines = regs.map((reg) => {
    const alias = reg.alias || "(tanpa alias)";
    return `├─ *${alias}*\n│  ├─ Name: ${reg.name || "-"}\n│  ├─ ID: ${idInline(reg.jid)}\n│  └─ Status: ${label(db, reg)}`;
  });
  return `╭─「 REGISTERED GROUPS 」\n│\n${lines.join("\n│\n")}\n│\n╰────────────`;
}

async function handler(m, ctx) {
  const regs = ctx.db.listRegistrations();
  if (!regs.length) {
    return m.reply("📋 Belum ada grup yang terdaftar.\n\n> Pakai `.registergroup` di dalam grup atau `.registergroup <id>` dari luar.");
  }
  await m.reply(plainList(regs, ctx.db));
}

export { pluginConfig as config, handler };
