/**
 * GX-ID — /bulkdelay (owner)
 *
 * Global jittered delay between consecutive bulk group actions (kickall/add/
 * fban). Not per-group: it governs how this account's automation looks overall.
 */
import { getBulkActionDelayRange, setBulkActionDelayRange } from "../../lib/settings.js";

const MAX_ALLOWED_MS = 60_000;

const pluginConfig = {
  name: "bulkdelay",
  alias: ["setbulkdelay"],
  category: "bot-config",
  description: "Atur jeda acak antar aksi massal di grup (global)",
  usage: ".bulkdelay <minMs> <maxMs>",
  examples: [".bulkdelay 500 1500"],
  permission: "owner",
  cooldown: 3,
  isEnabled: true,
};

async function handler(m, { config }) {
  const prefix = m.prefix || config.command?.prefix || ".";
  const min = Number(m.args?.[0]);
  const max = Number(m.args?.[1]);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min || max > MAX_ALLOWED_MS) {
    return m.reply(
      `⏱️ *Bulk Delay*\n\n> Usage: \`${prefix}bulkdelay <minMs> <maxMs>\`\n> Syarat: 0 ≤ min ≤ max ≤ ${MAX_ALLOWED_MS}`,
    );
  }
  setBulkActionDelayRange(min, max);
  await m.reply(`✅ Jeda aksi massal diatur ke *${min}-${max}ms*.`);
}

export { pluginConfig as config, handler };
