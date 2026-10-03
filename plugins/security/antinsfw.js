/**
 * GX-ID — /antinsfw (admin target / owner / whitelist)
 *
 * Toggles NSFW media moderation (images + video/GIF/animated stickers). The
 * classifier is on-device by default (`nsfwjs` + TensorFlow.js, offline); set
 * `NSFW_API_URL` to use an external classifier instead. When NO backend is
 * available the command still records the preference but moderation stays a
 * no-op — it never pretends to classify.
 *
 * Remote control: `.antinsfw kelas-a on` (permission checked against the target).
 */
import { isNsfwDetectorConfigured } from "../../lib/nsfw.js";
import { resolveManagedTarget } from "../../lib/group-registry.js";
import { parseToggle, toggleLabel } from "../../lib/plugin-utils.js";

const pluginConfig = {
  name: "antinsfw",
  alias: ["nonsfw", "larangnsfw"],
  category: "security",
  description: "Hapus otomatis media tidak pantas (gambar/video/GIF)",
  usage: ".antinsfw [grup] <on|off>",
  examples: [".antinsfw on", ".antinsfw kelas-a on"],
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
    const current = !!(ctx.db.getGroup(target.jid) || {}).antinsfw;
    return m.reply(
      `🔞 *Antinsfw* (${label}): ${toggleLabel(current)}\n\n> Usage: \`${prefix}antinsfw [grup] <on|off>\``,
    );
  }

  ctx.db.setGroup(target.jid, { antinsfw: state });

  let text = `✅ Antinsfw ${state ? "diaktifkan" : "dinonaktifkan"} untuk *${label}*.`;
  if (state && !isNsfwDetectorConfigured()) {
    text +=
      `\n\n⚠️ *Detektor NSFW tidak aktif.*\n` +
      `> Aktifkan model lokal (default) atau set \`NSFW_API_URL\`. ` +
      `Selama tidak ada backend, antinsfw tidak akan menghapus apa pun.`;
  } else if (state) {
    const backend = process.env.NSFW_API_URL ? "API eksternal" : "model lokal (on-device)";
    text += `\n\n> Detektor: *${backend}*.`;
  }
  await m.reply(text);
}

export { pluginConfig as config, handler };
