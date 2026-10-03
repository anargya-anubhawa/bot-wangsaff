/**
 * GX-ID — /revokelimit (owner)
 *
 * Merges the former `revokelimit` (set) and `revokelimitstatus` (show) plugins.
 * Controls the media size cap used by revoke ("delete for everyone") recovery.
 *
 *   .revokelimit <MB>      → set the cap
 *   .revokelimit           → show the current cap
 *   .revokelimit status    → same as above
 *
 * Aliases (back-compat): revokelimitstatus/revokelimitinfo, setrevokelimit,
 * revokeloglimit.
 */
import { getRevokeMaxBytes, setRevokeMaxBytes, REVOKE_MAX_BYTES_CEILING } from "../../lib/settings.js";

const MB = 1024 * 1024;
const DEFAULT_MB = getRevokeMaxBytes() / MB;
const CEILING_MB = REVOKE_MAX_BYTES_CEILING / MB;

const pluginConfig = {
  name: "revokelimit",
  alias: ["setrevokelimit", "revokelimitstatus", "revokelimitinfo", "revokeloglimit"],
  category: "bot-config",
  description: "Atur/tampilkan batas ukuran media yang dipulihkan saat pesan dihapus (revoke)",
  usage: ".revokelimit [MB|status]",
  examples: [".revokelimit 5", ".revokelimit status"],
  parameters: [
    { name: "MB", description: "Batas ukuran media revoke (MB)" },
    { name: "status", description: "Tampilkan batas saat ini" },
  ],
  helpOnEmpty: true,
  permission: "owner",
  cooldown: 3,
  isEnabled: true,
};

function statusText() {
  return `🗑️ *Revoke Limit*: *${(getRevokeMaxBytes() / MB).toFixed(0)}MB*`;
}

async function handler(m, ctx) {
  const prefix = m.prefix || ctx.config?.command?.prefix || ".";
  const invoked = String(m.command || "revokelimit").toLowerCase();
  const arg = m.args?.[0];

  if (invoked === "revokelimitstatus" || invoked === "revokelimitinfo") {
    return m.reply(statusText());
  }

  const lower = String(arg || "").toLowerCase();
  if (!arg || lower === "status" || lower === "info") {
    return m.reply(
      `${statusText()}\n\n> Default: ${DEFAULT_MB}MB • Maks: ${CEILING_MB}MB\n> Usage: \`${prefix}revokelimit <MB>\``,
    );
  }

  const mb = Number(arg);
  if (!Number.isFinite(mb) || mb <= 0 || mb > CEILING_MB) {
    return m.reply(`❌ Nilai tidak valid. Maksimum ${CEILING_MB}MB.`);
  }
  setRevokeMaxBytes(Math.round(mb * MB));
  await m.reply(`✅ Batas media revoke diatur ke *${mb}MB*.`);
}

export { pluginConfig as config, handler };
