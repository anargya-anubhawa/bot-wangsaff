/**
 * GX-ID — /regcontrol (owner/whitelist)
 *
 * Controls the group registration gate and marks the current chat as a
 * management (control-panel) group.
 *
 *   .regcontrol open        — every group may use the bot (default, legacy)
 *   .regcontrol registered  — only registered groups may use normal commands
 *   .regcontrol panel       — register this chat as a management group
 */
const pluginConfig = {
  name: "regcontrol",
  alias: ["regmode", "controlgroup"],
  category: "group-setup",
  description: "Atur mode registrasi grup & jadikan chat ini grup manajemen",
  usage: ".regcontrol <open|registered|panel>",
  examples: [".regcontrol registered", ".regcontrol panel"],
  helpOnEmpty: false,
  permission: "owner",
  cooldown: 3,
  isEnabled: true,
};

async function handler(m, { db, config }) {
  const prefix = m.prefix || config.command?.prefix || ".";
  const mode = (m.args?.[0] || "").toLowerCase();

  if (!mode) {
    const current = db.setting("regMode") || "open";
    return m.reply(
      `⚙️ *Registrasi Grup*\n\n> Mode saat ini: *${current.toUpperCase()}*\n\n` +
        `> \`${prefix}regcontrol open\` — semua grup boleh memakai bot\n` +
        `> \`${prefix}regcontrol registered\` — hanya grup terdaftar\n` +
        `> \`${prefix}regcontrol panel\` — jadikan chat ini grup manajemen`,
    );
  }

  if (mode === "panel") {
    if (!m.isGroup) return m.reply("❌ Grup manajemen hanya bisa berupa grup.");
    db.registerGroup(m.chat, {
      name: db.getRegistration(m.chat)?.name || m.groupMetadata?.subject || "",
      registeredBy: m.sender,
      status: "active",
      activated: true,
    });
    db.setGroup(m.chat, { isManagementGroup: true, registered: true });
    return m.reply(
      `✅ Chat ini sekarang menjadi *grup manajemen*.\n\n> Pakai \`${prefix}link <id grup>\` untuk mulai mengelola grup lain yang sudah terdaftar.`,
    );
  }

  if (mode !== "open" && mode !== "registered") {
    return m.reply(`❌ Mode tidak dikenal. Gunakan \`open\`, \`registered\`, atau \`panel\`.`);
  }

  db.setting("regMode", mode);
  await m.reply(
    mode === "registered"
      ? `✅ *Gate registrasi aktif.* Hanya grup terdaftar yang bisa memakai perintah normal.`
      : `✅ *Gate registrasi nonaktif.* Semua grup bisa memakai bot.`,
  );
}

export { pluginConfig as config, handler };
