/**
 * GX-ID — /setgroupalias (owner/whitelist)
 *
 * Gives a registered group a short, human-friendly alias used in place of its
 * long id by every group-targeting command.
 *
 *   .setgroupalias <alias>            → alias for THIS group
 *   .setgroupalias <alias> <id grup>  → alias for a remote group
 *
 * The alias is only a resolver — configuration is still stored by group id.
 */
import { resolveGroup, setGroupAlias, isValidAlias, ALIAS_NOT_FOUND_MESSAGE } from "../../lib/group-registry.js";

const pluginConfig = {
  name: "setgroupalias",
  alias: ["aliasgroup", "grupalias", "setalias"],
  category: "group-setup",
  description: "Beri alias pada grup terdaftar agar mudah dipanggil",
  usage: ".setgroupalias <alias> [id grup]",
  examples: [".setgroupalias kelas-a", ".setgroupalias kelas-a 120363001@g.us"],
  permission: "owner",
  cooldown: 3,
  isEnabled: true,
};

async function handler(m, { db, config }) {
  const prefix = m.prefix || config.command?.prefix || ".";
  const args = m.args || [];
  const alias = args[0];
  const targetArg = args[1];

  if (!alias) {
    return m.reply(
      `🏷️ *Set Alias Grup*\n\n> Usage: \`${prefix}setgroupalias <alias> [id grup]\`\n> Contoh: \`${prefix}setgroupalias kelas-a\`\n\n> Aturan alias: huruf kecil, angka, \`_\`, \`-\` (2–32 karakter).`,
    );
  }

  if (!isValidAlias(alias)) {
    return m.reply("❌ Alias tidak valid. Gunakan huruf kecil, angka, `_` atau `-` (2–32 karakter).");
  }

  let jid = m.chat;
  if (targetArg) {
    const resolved = resolveGroup(targetArg);
    if (!resolved) {
      return m.reply(ALIAS_NOT_FOUND_MESSAGE);
    }
    jid = resolved.groupId;
  } else if (!m.isGroup) {
    return m.reply(`❌ Sebutkan grup target dari luar grup.\n\n> Contoh: \`${prefix}setgroupalias ${alias} 120363001@g.us\``);
  }

  const reg = db.getRegistration(jid);
  if (!reg) {
    return m.reply(`❌ Grup \`${jid.split("@")[0]}\` belum terdaftar. Daftarkan dulu dengan \`${prefix}registergroup\`.`);
  }

  const res = setGroupAlias(jid, alias);
  if (!res.ok) return m.reply(`❌ ${res.error}`);

  await m.reply(
    `✅ *Alias disimpan.*\n\n> Grup: *${reg.name || jid.split("@")[0]}*\n> Alias: \`${res.alias}\`\n\n> Sekarang bisa dipakai: \`${prefix}notes ${res.alias}\``,
  );
}

export { pluginConfig as config, handler };
