/**
 * GX-ID — /antivirtex (admin target / owner / whitelist)
 *
 * Toggles automatic deletion of "virtex" messages (very long unbroken tokens /
 * heavy combining-mark spam) posted by ordinary members. Supports remote
 * targeting by alias or id: `.antivirtex kelas-a on`.
 */
import { resolveManagedTarget } from "../../lib/group-registry.js";
import { parseToggle, toggleLabel } from "../../lib/plugin-utils.js";

const pluginConfig = {
  name: "antivirtex",
  alias: ["novirtex", "larangvirtex"],
  category: "security",
  description: "Hapus otomatis pesan yang diduga teks perusak (virtex)",
  usage: ".antivirtex [grup] <on|off>",
  examples: [".antivirtex on", ".antivirtex kelas-a on"],
  helpOnEmpty: false,
  permission: "all",
  cooldown: 5,
  isEnabled: true,
};

async function handler(m, ctx) {
  const prefix = m.prefix || ctx.config?.command?.prefix || ".";
  const args = m.args || [];

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
  if (state === null && args.length) targetArg = args[args.length - 1];

  const target = await resolveManagedTarget(m, ctx, { args: targetArg ? [targetArg] : [] });
  if (target.error) return m.reply(target.error);

  const label = target.alias || target.jid.split("@")[0];

  if (state === null) {
    const current = !!(ctx.db.getGroup(target.jid) || {}).antivirtex;
    return m.reply(
      `🧨 *Antivirtex* (${label}): ${toggleLabel(current)}\n\n> Usage: \`${prefix}antivirtex [grup] <on|off>\``,
    );
  }

  ctx.db.setGroup(target.jid, { antivirtex: state });
  await m.reply(`✅ Antivirtex ${state ? "diaktifkan" : "dinonaktifkan"} untuk *${label}*.`);
}

export { pluginConfig as config, handler };
