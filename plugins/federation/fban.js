/**
 * GX-ID — /fban (admin, bot-admin)
 *
 * Federation ban: removes the target from every group in a federation and
 * records the number on that federation's ban list.
 *
 *   .fban <target>                  → ban across the federation linked to THIS group
 *   .fban <fed> <target>            → ban across the given federation (name or id)
 *   .fban list [fed]                → show who is banned in a federation
 *   .fban unban <target>            → lift the ban in the linked federation
 *   .fban unban <fed> <target>      → lift the ban in the given federation
 *
 * `<target>` is a reply, a mention, or a phone number. When no federation is
 * given, the federation linked to the group the command runs in is used; if
 * this group has no federation, the target is only removed from this group.
 */
import { numberFromJid } from "../../lib/group-utils.js";
import { removeMembers } from "../../lib/group-service.js";
import { ensureBotAdmin, BOT_NOT_ADMIN } from "../../lib/plugin-utils.js";
import { isOwner } from "../../lib/access.js";

const pluginConfig = {
  name: "fban",
  alias: ["federationban", "bannedfederation"],
  category: "federation",
  description: "Ban/unban anggota di seluruh grup federasi",
  usage: ".fban [fed] <@user|nomor>  |  .fban list [fed]  |  .fban unban [fed] <@user|nomor>",
  examples: [
    ".fban @user",
    ".fban nusantara @user",
    ".fban list nusantara",
    ".fban unban @user",
  ],
  permission: "admin",
  isBotAdmin: true,
  cooldown: 5,
  isEnabled: true,
};

/** First reply/mention target, or null. */
function directTarget(m) {
  const jid = m.quoted?.sender || (m.mentionedJid?.length ? m.mentionedJid[0] : null);
  return jid ? { jid, number: numberFromJid(jid) } : null;
}

/** A JID (or bare number) shaped from a token that looks like a phone number. */
function numberTarget(token) {
  const num = String(token || "").replace(/[^0-9]/g, "");
  return num.length >= 8 ? { jid: `${num}@s.whatsapp.net`, number: num } : null;
}

/** First phone-number-looking token in `args`, or null. */
function targetFromArgs(args) {
  for (const a of args) {
    const t = numberTarget(a);
    if (t) return t;
  }
  return null;
}

/** The federation linked to the group a command runs in, or null. */
function linkedFederation(m, db) {
  const group = db.getGroup(m.chat) || {};
  return group.federationId ? db.getFederation(group.federationId) : null;
}

async function handler(m, { sock, db, config }) {
  const prefix = m.prefix || config.command?.prefix || ".";
  const args = m.args || [];
  const sub = (args[0] || "").toLowerCase();

  if (sub === "list") return handleList(m, db, args.slice(1), prefix);
  if (sub === "unban") return handleUnban(m, sock, db, args.slice(1), prefix);
  return handleBan(m, sock, db, args, prefix);
}

/**
 * Resolve `{ target, fed, fedQuery }` from the arguments. The target is a
 * reply/mention, or the first phone-number-looking token; the federation is
 * every remaining token joined (so multi-word fed names survive). When no fed
 * is named, the federation linked to the current group is used.
 */
function resolveBanArgs(m, db, args) {
  const target = directTarget(m) || targetFromArgs(args);
  /* Federation = every token that is not a number/mention; joined so
     multi-word fed names survive. */
  const fedQuery = args
    .filter((a) => !isNumberToken(a))
    .filter((a) => !target || String(a).replace(/[^0-9]/g, "") !== target.number)
    .join(" ")
    .trim();
  const fed = fedQuery ? db.findFederation(fedQuery) : linkedFederation(m, db);
  return { target, fed, fedQuery };
}

/** True when a token is just a phone number/mention (digits, +, spaces, dashes, @). */
function isNumberToken(token) {
  const t = String(token || "");
  if (!/^[@+]?[\d\s-]+$/.test(t)) return false;
  return t.replace(/[^0-9]/g, "").length >= 8;
}

async function handleBan(m, sock, db, args, prefix) {
  const { target, fed, fedQuery } = resolveBanArgs(m, db, args);
  if (!target) {
    return m.reply(
      `❌ *Target tidak ditemukan.*\n\n> Balas pesan atau mention seseorang.\n> Contoh: \`${prefix}fban @user\` atau \`${prefix}fban <fed> @user\``,
    );
  }
  if (fedQuery && !fed) return m.reply(`❌ Federasi \`${fedQuery}\` tidak ditemukan.`);
  if (isOwner(target.jid)) return m.reply("❌ Tidak bisa fban owner.");
  if (!(await ensureBotAdmin(m, sock))) return m.reply(BOT_NOT_ADMIN);

  const { jid, number } = target;

  /* No federation → legacy behaviour: remove from this group only. */
  if (!fed) {
    try {
      await removeMembers(sock, m.chat, [jid]);
    } catch (error) {
      throw error;
    }
    return m.reply(
      `✅ @${number} dikeluarkan dari grup ini.\n\n> Grup ini tidak tertaut federasi, jadi tidak ada grup lain yang terpengaruh.\n> Gabungkan ke federasi dengan \`${prefix}fedjoin <id>\` atau ban ke fed tertentu: \`${prefix}fban <fed> @user\`.`,
      { mentions: [jid] },
    );
  }

  db.addFederationBan(fed.id, jid);

  const groups = (fed.groups || []).filter(Boolean);
  const succeeded = [];
  const failed = [];
  for (const groupJid of groups) {
    try {
      await removeMembers(sock, groupJid, [jid]);
      succeeded.push(String(groupJid).split("@")[0]);
    } catch {
      failed.push(String(groupJid).split("@")[0]);
    }
  }

  let text =
    `🚫 @${number} di-*fban* dari federasi *${fed.name || fed.id}*.\n` +
    `> Dikeluarkan dari ${succeeded.length}/${groups.length} grup.`;
  if (failed.length) text += `\n⚠️ Gagal di: ${failed.join(", ")}`;
  text += `\n> Lihat daftar: \`${prefix}fban list ${fed.id}\``;
  await m.reply(text, { mentions: [jid] });
}

async function handleUnban(m, sock, db, args, prefix) {
  const { target, fed } = resolveBanArgs(m, db, args);
  if (!target) {
    return m.reply(
      `❌ *Target tidak ditemukan.*\n\n> Balas pesan atau mention seseorang.\n> Contoh: \`${prefix}fban unban @user\` atau \`${prefix}fban unban <fed> @user\``,
    );
  }
  if (!fed) {
    return m.reply(
      `❌ Grup ini tidak tertaut federasi.\n\n> Sebutkan fed: \`${prefix}fban unban <fed> @user\``,
    );
  }

  db.removeFederationBan(fed.id, target.jid);
  await m.reply(
    `✅ @${target.number} di-*unban* dari federasi *${fed.name || fed.id}*.\n> Nomor ini bisa masuk kembali ke grup federasi.`,
    { mentions: [target.jid] },
  );
}

async function handleList(m, db, args, prefix) {
  const query = args.join(" ").trim();
  const fed = query ? db.findFederation(query) : linkedFederation(m, db);

  if (query && !fed) return m.reply(`❌ Federasi \`${query}\` tidak ditemukan.`);
  if (!fed) {
    return m.reply(
      `❌ Grup ini tidak tertaut federasi.\n\n> Sebutkan fed: \`${prefix}fban list <id|alias fed>\``,
    );
  }

  const bans = db.listFederationBans(fed.id);
  const groups = (fed.groups || []).length;
  if (!bans.length) {
    return m.reply(
      `🚫 *F-Ban List*\n\n> Federasi: *${fed.name || fed.id}* (\`${fed.id}\`)\n> Grup: ${groups}\n\n> Belum ada nomor yang di-ban.`,
    );
  }

  const lines = bans.map((num, i) => `${i + 1}. @${num}`);
  const mentions = bans.map((num) => `${num}@s.whatsapp.net`);
  await m.reply(
    `🚫 *F-Ban List*\n\n` +
      `> Federasi: *${fed.name || fed.id}* (\`${fed.id}\`)\n` +
      `> Grup: ${groups}  |  Total ban: *${bans.length}*\n\n` +
      lines.join("\n") +
      `\n\n> Unban: \`${prefix}fban unban ${fed.id} <nomor>\``,
    { mentions },
  );
}

export { pluginConfig as config, handler };
