/**
 * GX-ID — /whitelist (owner)
 *
 * Manages the global whitelist of trusted numbers. A whitelisted number is
 * trusted ONLY in private chat (PC): inside a group it is an ordinary member —
 * it is moderated, cooldowned and never granted admin/owner tiers. The owner is
 * always trusted everywhere and is implicitly whitelisted.
 *
 *   .whitelist list
 *   .whitelist add <nomor>
 *   .whitelist del <nomor>
 *   .whitelist on            → aktifkan fitur whitelist
 *   .whitelist off           → matikan fitur whitelist (tanpa hapus daftar)
 */
import { isWhitelistEnabled, setWhitelistEnabled } from "../../lib/access.js";
import { parseToggle } from "../../lib/plugin-utils.js";

const pluginConfig = {
  name: "whitelist",
  alias: ["wl", "allow", "disallow"],
  category: "bot-config",
  description: "Kelola daftar putih (whitelist) nomor terpercaya",
  usage: ".whitelist <list|add|del|on|off> [nomor]",
  examples: [
    ".whitelist list",
    ".whitelist add 6281234567890",
    ".whitelist del 6281234567890",
    ".whitelist on",
    ".whitelist off",
  ],
  helpOnEmpty: false,
  permission: "owner",
  cooldown: 3,
  isEnabled: true,
};

function normalize(input) {
  let num = String(input || "").replace(/[^0-9]/g, "");
  if (num.startsWith("0")) num = `62${num.slice(1)}`;
  return num.length >= 8 ? num : null;
}

/** Shared footer describing the PC-only rule. */
const PC_NOTE = "> ℹ️ Whitelist hanya berlaku di *private chat (PC)* — di dalam grup, member tetap seperti biasa.";

async function handler(m, { db, config }) {
  const prefix = m.prefix || config.command?.prefix || ".";
  const action = (m.args?.[0] || "").toLowerCase();
  const arg = m.args?.[1];

  /* `.whitelist on` / `.whitelist off` — toggle the feature */
  const toggle = parseToggle(action);
  if (toggle !== null) {
    setWhitelistEnabled(toggle);
    return m.reply(
      toggle
        ? `✅ *Whitelist diaktifkan.*\n\n> Nomor terdaftar kembali dipercaya di private chat.\n${PC_NOTE}`
        : `❌ *Whitelist dimatikan.*\n\n> Daftar tetap tersimpan, tetapi tidak berpengaruh sampai diaktifkan lagi.\n> Nyalakan: \`${prefix}whitelist on\``,
    );
  }

  /* `.whitelist list` (default when no argument) */
  if (action === "list" || !action) {
    const enabled = isWhitelistEnabled();
    const status = enabled ? "✅ ON" : "❌ OFF";
    const list = db.listWhitelist();
    if (!list.length) {
      return m.reply(
        `📋 *Whitelist kosong.*\n\n> Status: *${status}*\n> Tambah: \`${prefix}whitelist add <nomor>\`\n> Owner selalu otomatis whitelist.\n\n${PC_NOTE}`,
      );
    }
    const lines = list.map((e, i) => `┃ ${i + 1}. ${e.number || e}`);
    return m.reply(
      `📋 *Whitelist (${list.length})* — *${status}*\n\n${lines.join("\n")}\n\n> Hapus: \`${prefix}whitelist del <nomor>\`\n${PC_NOTE}`,
    );
  }

  if (action === "add") {
    const number = normalize(arg);
    if (!number) return m.reply(`❌ Nomor tidak valid.\n\n> Contoh: \`${prefix}whitelist add 6281234567890\``);
    if (db.isWhitelisted(number)) return m.reply(`⚠️ ${number} sudah ada di whitelist.`);
    db.addWhitelist(number, m.sender);
    return m.reply(`✅ ${number} ditambahkan ke whitelist.\n\n${PC_NOTE}`);
  }

  if (action === "del" || action === "remove") {
    const number = normalize(arg);
    if (!number) return m.reply(`❌ Nomor tidak valid.`);
    const removed = db.removeWhitelist(number);
    if (!removed) return m.reply(`⚠️ ${number} tidak ada di whitelist.`);
    return m.reply(`✅ ${number} dihapus dari whitelist.`);
  }

  return m.reply(
    `❌ Sub-perintah tidak dikenal.\n\n> Usage: \`${prefix}whitelist <list|add|del|on|off> [nomor]\``,
  );
}

export { pluginConfig as config, handler };
