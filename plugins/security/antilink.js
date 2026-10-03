/**
 * GX-ID — /antilink (admin target / owner / whitelist)
 *
 * Toggles automatic deletion of links posted by non-admin, non-whitelist
 * members. Works remotely:
 *
 *   .antilink on            → current group
 *   .antilink kelas-a on    → target group by alias or id
 *
 * Permission is checked against the TARGET group (`canManageGroup`), so an admin
 * of a different group cannot change this one.
 */
import { resolveManagedTarget } from "../../lib/group-registry.js";
import { parseToggle, toggleLabel } from "../../lib/plugin-utils.js";

const pluginConfig = {
  name: "antilink",
  alias: ["nolink", "laranglink"],
  category: "security",
  description: "Hapus otomatis link dari anggota non-admin/non-whitelist",
  usage: ".antilink [grup] <on|off>",
  examples: [".antilink on", ".antilink kelas-a on"],
  helpOnEmpty: false,
  permission: "all",
  cooldown: 5,
  isEnabled: true,
};

async function handler(m, ctx) {
  const prefix = m.prefix || ctx.config?.command?.prefix || ".";
  const args = m.args || [];

  /* the toggle is the LAST recognised on/off token; anything before it is target */
  let state = null;
  let targetArg = null;
  for (let i = args.length - 1; i >= 0; i--) {
    const parsed = parseToggle(args[i]);
    if (parsed !== null) {
      state = parsed;
      targetArg = args[i - 1] || null;
      break;
    }
  }
  // no toggle token → maybe just `.antilink <target>` (show state)
  if (state === null && args.length) targetArg = args[args.length - 1];

  const target = await resolveManagedTarget(m, ctx, { args: targetArg ? [targetArg] : [] });
  if (target.error) return m.reply(target.error);

  const label = target.alias || target.jid.split("@")[0];

  if (state === null) {
    const current = !!(ctx.db.getGroup(target.jid) || {}).antilink;
    return m.reply(
      `🔗 *Antilink* (${label}): ${toggleLabel(current)}\n\n> Usage: \`${prefix}antilink [grup] <on|off>\``,
    );
  }

  ctx.db.setGroup(target.jid, { antilink: state });
  await m.reply(`✅ Antilink ${state ? "diaktifkan" : "dinonaktifkan"} untuk *${label}*.`);
}

export { pluginConfig as config, handler };
