/**
 * GX-ID — /registergroup (owner/whitelist)
 *
 * Registers a group so the bot may use it (and, when `regMode` is
 * "registered", so its members may run normal commands). Three forms:
 *
 *   .registergroup                     → register THIS group (optional name)
 *   .registergroup <id|invite-link>    → register a group remotely
 *   .registergroup <alias> <id|link>   → register remotely AND set its alias
 *
 * Only OWNER/WHITELIST may register, so remote registration can never be
 * abused by an ordinary member.
 */
import { isOwnerOrWhitelistedIn } from "../../lib/access.js";
import { ensureBotAdmin } from "../../lib/plugin-utils.js";
import { setGroupAlias, isValidAlias, resolveGroup, BOT_NOT_IN_GROUP_MESSAGE } from "../../lib/group-registry.js";
import { idCodeBlock } from "../../lib/group-id.js";

const pluginConfig = {
  name: "registergroup",
  alias: ["daftargroup", "registergc", "aktifkangrup"],
  category: "group-setup",
  description: "Daftarkan grup (dari dalam grup atau dari luar via id/alias)",
  usage: ".registergroup [alias] [id grup|link undangan]",
  examples: [".registergroup", ".registergroup Tim Marketing", ".registergroup kelas-a 120363001@g.us", ".registergroup https://chat.whatsapp.com/XXXX"],
  permission: "owner",
  cooldown: 3,
  isEnabled: true,
};

const INVITE_RE = /(?:https?:\/\/)?chat\.whatsapp\.com\/([^\s?/#]+)/i;

/** A token that plausibly names a group: an invite link, a JID, or bare digits. */
function looksLikeGroupRef(token) {
  const t = String(token || "").trim();
  if (!t) return false;
  if (INVITE_RE.test(t)) return true;
  if (/@g\.us$/i.test(t)) return true;
  if (/^\d{5,}$/.test(t)) return true;
  return !!resolveGroup(t);
}

/** Turn an id / JID / invite link into a group JID, or an error string. */
async function toGroupJid(token, sock) {
  const t = String(token || "").trim();
  const invite = INVITE_RE.exec(t);
  if (invite) {
    if (typeof sock.groupGetInviteInfo !== "function") return { error: "API invite grup tidak tersedia." };
    try {
      const info = await sock.groupGetInviteInfo(invite[1]);
      if (!info?.id) return { error: "ID grup tidak ditemukan dari link undangan." };
      return { jid: info.id, name: info.subject || "" };
    } catch {
      return { error: "Gagal membaca link undangan (mungkin kedaluwarsa)." };
    }
  }
  let jid = null;
  if (/@g\.us$/i.test(t)) jid = t;
  else if (/^\d{5,}$/.test(t)) jid = `${t}@g.us`;
  else {
    const resolved = resolveGroup(t);
    if (resolved) jid = resolved.groupId;
  }
  if (!jid) return { error: `Target \`${t}\` tidak dikenali.` };

  // Fetch the group's subject so an id-registration is not stored nameless.
  // This also tells us whether the bot is already a member.
  let name = "";
  let inGroup = null;
  if (typeof sock.groupMetadata === "function") {
    try {
      const meta = await sock.groupMetadata(jid);
      name = meta?.subject || "";
      inGroup = !!meta;
    } catch {
      // bot is not in the group (or metadata failed) — name stays empty
      inGroup = false;
    }
  }
  return { jid, name, inGroup };
}

async function handler(m, { sock, db, config }) {
  const prefix = m.prefix || config.command?.prefix || ".";
  const args = m.args || [];

  /* ── resolve (target, alias) from the arguments ── */
  let targetToken = null;
  let alias = null;

  if (args.length === 0) {
    if (!m.isGroup) {
      return m.reply(
        `📝 *Daftarkan Grup*\n\n> Dari dalam grup: \`${prefix}registergroup\`\n> Dari luar: \`${prefix}registergroup <id grup|link>\`\n> Dengan alias: \`${prefix}registergroup <alias> <id grup|link>\``,
      );
    }
  } else if (looksLikeGroupRef(args[0])) {
    targetToken = args[0];
    if (args[1] && isValidAlias(args[1])) alias = args[1];
  } else if (args.length >= 2 && looksLikeGroupRef(args[1])) {
    alias = args[0];
    targetToken = args[1];
  }

  /* ── remote registration ── */
  if (targetToken) {
    if (!isOwnerOrWhitelistedIn(m)) {
      return m.reply("👑 *Hanya owner* yang boleh mendaftarkan grup secara remote.");
    }
    const conv = await toGroupJid(targetToken, sock);
    if (conv.error) return m.reply(`❌ ${conv.error}`);
    const jid = conv.jid;

    const existing = db.getRegistration(jid);
    if (existing && existing.status === "active") {
      if (alias) {
        const res = setGroupAlias(jid, alias);
        if (!res.ok) return m.reply(`❌ ${res.error}`);
        return m.reply(`♻️ Grup sudah terdaftar. Alias diperbarui menjadi \`${res.alias}\`.`);
      }
      return m.reply(`⚠️ Grup \`${jid.split("@")[0]}\` sudah terdaftar.`);
    }

    if (alias && !isValidAlias(alias)) {
      return m.reply("❌ Alias tidak valid. Gunakan huruf kecil, angka, `_` atau `-` (2–32 karakter).");
    }

    db.registerGroup(jid, {
      name: conv.name || db.getGroup(jid)?.name || "",
      alias: alias || null,
      registeredBy: m.sender,
      status: "active",
      activated: true,
    });
    db.setGroup(jid, { registered: true, allowAdminCommands: true });
    if (alias) setGroupAlias(jid, alias);

    const warn = conv.inGroup === false ? `\n\n${BOT_NOT_IN_GROUP_MESSAGE}` : "";
    const label = conv.name || db.getGroup(jid)?.name || "-";

    await m.reply(
      `✅ *Grup didaftarkan (remote).*\n\n> ${alias ? `Alias: \`${alias}\`\n> ` : ""}Nama: *${label}*\n> ID: ${idCodeBlock(jid)}${warn}`,
    );
    return;
  }

  /* ── in-group registration (legacy behaviour) ── */
  if (!m.isGroup) {
    return m.reply("❌ Perintah ini hanya dapat digunakan di dalam grup.");
  }

  const customName = m.text?.trim() || "";
  const existing = db.getRegistration(m.chat);
  if (existing && existing.status === "active") {
    return m.reply(`⚠️ Grup ini sudah terdaftar${existing.name ? ` sebagai *${existing.name}*` : ""}.`);
  }

  db.registerGroup(m.chat, {
    name: customName || m.groupMetadata?.subject || "",
    registeredBy: m.sender,
    status: "active",
    activated: true,
  });
  db.setGroup(m.chat, { registered: true, allowAdminCommands: true });

  const botAdmin = m.isBotAdmin || (await ensureBotAdmin(m, sock));
  let text =
    `✅ *Grup didaftarkan.*\n\n` +
    `> Nama: *${customName || m.groupMetadata?.subject || "-"}*\n` +
    `> ID: ${idCodeBlock(m.chat)}`;
  if (!botAdmin) {
    text += `\n\n⚠️ Bot belum menjadi admin di grup ini — sebagian perintah mungkin dibatasi.`;
  }
  text += `\n\n> Atur alias: \`${prefix}setgroupalias <alias>\``;
  await m.reply(text);
}

export { pluginConfig as config, handler };
