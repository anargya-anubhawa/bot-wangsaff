/**
 * GX-ID — /log (owner) — unified logging control
 *
 * Single entry point for every moderation-log setting: where a group's log is
 * forwarded, the deleted-message log scope, and the `.rvo` scope.
 *
 *   .log                              → status + help
 *   .log set <grup>                   → forward <grup>'s logs to THIS chat
 *   .log set <grup> <panel>           → forward <grup>'s logs to <panel> (alias or id)
 *   .log reset <grup>                 → back to the default (global panel)
 *
 *   .log default                      → make THIS chat the global default panel
 *   .log default <panel>              → make <panel> the global default panel
 *   .log default reset                → clear the global default panel
 *
 *   .log scope                        → show the deleted-message log scope
 *   .log scope registered|public      → only registered groups / every group
 *
 *   .log rvo                          → show the `.rvo` (view-once) scope
 *   .log rvo registered|public        → `.rvo` only in registered groups / everywhere
 *
 * A registered group with no explicit panel forwards to the *global default
 * panel* (falling back to the group itself only when none is set). That global
 * panel also receives public-mode logs from non-registered groups.
 *
 * Back-compat: `.logscope …` and `.rvoscope …` remain valid aliases of
 * `.log scope …` and `.log rvo …`.
 */
import { resolveGroup, ALIAS_NOT_FOUND_MESSAGE } from "../../lib/group-registry.js";
import {
  getDefaultLogPanel,
  setDefaultLogPanel,
  getLogScope,
  setLogScope,
  getRvoScope,
  setRvoScope,
} from "../../lib/settings.js";

const SCOPE_ALIASES = ["logscope", "setlogscope", "logmode"];
const RVO_SCOPE_ALIASES = ["rvoscope", "setrvoscope", "rvomode"];

const pluginConfig = {
  name: "log",
  alias: ["logpanel", "setlogpanel", "setpanelog", ...SCOPE_ALIASES, ...RVO_SCOPE_ALIASES],
  category: "group-setup",
  description: "Atur panel & cakupan log moderasi (scope log, scope rvo, panel default)",
  usage: ".log [set|reset|default|scope|rvo] ...",
  examples: [
    ".log",
    ".log scope public",
    ".log rvo registered",
    ".log set kelas-a",
    ".log set kelas-a 120363999@g.us",
    ".log reset kelas-a",
    ".log default",
  ],
  helpOnEmpty: false,
  permission: "owner",
  cooldown: 3,
  isEnabled: true,
};

async function handler(m, { db, config }) {
  const prefix = m.prefix || config.command?.prefix || ".";
  const args = m.args || [];
  const invoked = String(m.command || "log").toLowerCase();
  const sub = (args[0] || "").toLowerCase();

  /* Back-compat: `.logscope …` → `.log scope …` */
  if (SCOPE_ALIASES.includes(invoked)) return handleScope(m, args[0], prefix);
  /* Back-compat: `.rvoscope …` → `.log rvo …` */
  if (RVO_SCOPE_ALIASES.includes(invoked)) return handleRvoScope(m, args[0], prefix);

  if (!args.length) return showStatus(m, prefix);
  if (sub === "default") return handleDefault(m, args[1], prefix);
  if (sub === "reset") return handleReset(m, db, args[1], prefix);
  if (sub === "set") return handleSet(m, db, args.slice(1), prefix);
  if (sub === "scope" || SCOPE_ALIASES.includes(sub)) return handleScope(m, args[1], prefix);
  if (sub === "rvo" || RVO_SCOPE_ALIASES.includes(sub)) return handleRvoScope(m, args[1], prefix);

  /* `.log <grup> [panel]` — convenience shorthand for `.log set ...` */
  if (resolveGroup(args[0])) return handleSet(m, db, args, prefix);

  return showStatus(m, prefix);
}

/** Show the current configuration + usage. */
async function showStatus(m, prefix) {
  const panel = getDefaultLogPanel();
  await m.reply(
    `🗂️ *Log Panel*\n\n` +
      `> Panel default global: ${panel ? `*${String(panel).split("@")[0]}*` : "_belum diatur_"}\n` +
      `> Log scope: *${getLogScope().toUpperCase()}*\n` +
      `> RVO scope: *${getRvoScope().toUpperCase()}*\n\n` +
      `> \`${prefix}log set <grup> [panel]\` — forward log grup ke chat ini / panel lain\n` +
      `> \`${prefix}log reset <grup>\` — kembali ke default\n` +
      `> \`${prefix}log default [panel]\` — panel default global\n` +
      `> \`${prefix}log default reset\` — hapus panel default\n` +
      `> \`${prefix}log scope <registered|public>\` — cakupan log pesan dihapus\n` +
      `> \`${prefix}log rvo <registered|public>\` — cakupan fitur \`.rvo\`\n\n` +
      `> Grup terdaftar otomatis memakai panel default global.\n` +
      `> Pesan yang dihapus (termasuk foto/video) ikut diteruskan ke panel.`,
  );
}

/** `.log set <grup> [panel]` */
async function handleSet(m, db, args, prefix) {
  const groupArg = args[0];
  const panelArg = args[1];
  if (!groupArg) return m.reply(`❌ Sebutkan grup: \`${prefix}log set <grup> [panel]\``);

  const group = resolveGroup(groupArg);
  if (!group) return m.reply(ALIAS_NOT_FOUND_MESSAGE);

  let panelJid;
  if (panelArg) {
    const resolved = resolveGroup(panelArg);
    if (!resolved) return m.reply(ALIAS_NOT_FOUND_MESSAGE);
    panelJid = resolved.groupId;
  } else if (m.isGroup) {
    panelJid = m.chat;
  } else {
    return m.reply("❌ Dari luar grup, sebutkan panel target: `.log set <grup> <panel>`.");
  }

  db.setRegistrationLogPanel(group.groupId, panelJid);
  await m.reply(`✅ Log *${group.alias || groupArg}* sekarang dikirim ke *${panelJid.split("@")[0]}*.`);
}

/** `.log reset <grup>` */
async function handleReset(m, db, arg, prefix) {
  if (!arg) return m.reply(`❌ Sebutkan grup: \`${prefix}log reset <grup>\``);
  const group = resolveGroup(arg);
  if (!group) return m.reply(ALIAS_NOT_FOUND_MESSAGE);

  db.setRegistrationLogPanel(group.groupId, null);
  const fallback = getDefaultLogPanel();
  await m.reply(
    `✅ Log *${group.alias || arg}* kembali ke default${fallback ? ` — panel global *${String(fallback).split("@")[0]}*` : " — grup itu sendiri (panel default belum diatur)"}.`,
  );
}

/** `.log default [panel|reset]` */
async function handleDefault(m, arg, prefix) {
  if (String(arg || "").toLowerCase() === "reset") {
    setDefaultLogPanel(null);
    return m.reply("✅ Panel default global dihapus. Grup tanpa panel khusus kembali ke grup itu sendiri.");
  }

  if (!arg) {
    if (!m.isGroup) {
      return m.reply(
        `❌ Panel default harus berupa grup.\n\n> Dari dalam grup: \`${prefix}log default\`\n> Atau sebutkan panel: \`${prefix}log default <grup>\``,
      );
    }
    setDefaultLogPanel(m.chat);
    return m.reply(`✅ Chat ini sekarang menjadi *panel default global*.`);
  }

  const resolved = resolveGroup(arg);
  if (!resolved) return m.reply(ALIAS_NOT_FOUND_MESSAGE);
  setDefaultLogPanel(resolved.groupId);
  await m.reply(`✅ Panel default global diset ke *${resolved.groupId.split("@")[0]}*.`);
}

/** `.log scope [registered|public]` */
async function handleScope(m, value, prefix) {
  const arg = String(value || "").toLowerCase();

  if (arg === "registered" || arg === "public") {
    setLogScope(arg);
    const panel = getDefaultLogPanel();
    const warn =
      arg === "public" && !panel
        ? `\n\n⚠️ Panel default belum diatur — set dengan \`${prefix}log default\` di grup panel.`
        : "";
    return m.reply(`✅ *Log scope* diset ke *${arg.toUpperCase()}*.${warn}`);
  }

  if (arg) return m.reply(`❌ Nilai tidak valid. Gunakan \`registered\` atau \`public\`.`);

  const current = getLogScope();
  const panel = getDefaultLogPanel();
  await m.reply(
    `🗂️ *Log Scope (pesan dihapus)*\n\n` +
      `> Mode saat ini: *${current.toUpperCase()}*\n` +
      `> Panel default : ${panel ? `*${String(panel).split("@")[0]}*` : "_belum diatur_"}\n\n` +
      `> \`${prefix}log scope registered\` — hanya grup terdaftar\n` +
      `> \`${prefix}log scope public\` — semua grup (non-terdaftar ke panel default)\n\n` +
      `> Berlaku untuk \`.del\`, antilink, antivirtex, antinsfw, blacklist & revoke.`,
  );
}

/** `.log rvo [registered|public]` */
async function handleRvoScope(m, value, prefix) {
  const arg = String(value || "").toLowerCase();

  if (arg === "registered" || arg === "public") {
    setRvoScope(arg);
    return m.reply(`✅ *RVO scope* diset ke *${arg.toUpperCase()}*.`);
  }

  if (arg) return m.reply(`❌ Nilai tidak valid. Gunakan \`registered\` atau \`public\`.`);

  await m.reply(
    `👁️ *RVO Scope*\n\n` +
      `> Mode saat ini: *${getRvoScope().toUpperCase()}*\n\n` +
      `> \`${prefix}log rvo registered\` — \`.rvo\` hanya di grup terdaftar & di-log\n` +
      `> \`${prefix}log rvo public\` — \`.rvo\` bisa di semua grup\n\n` +
      `> Tujuan log mengikuti scope log pesan dihapus.`,
  );
}

export { pluginConfig as config, handler };
