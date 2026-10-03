/**
 * GX-ID — /bulkdelaystatus (owner)
 */
import { getBulkActionDelayRange } from "../../lib/settings.js";

const pluginConfig = {
  name: "bulkdelaystatus",
  alias: ["bulkdelayinfo"],
  category: "bot-config",
  description: "Tampilkan jeda aksi massal saat ini",
  usage: ".bulkdelaystatus",
  examples: [".bulkdelaystatus"],
  permission: "owner",
  cooldown: 3,
  isEnabled: true,
};

async function handler(m) {
  const [min, max] = getBulkActionDelayRange();
  await m.reply(`⏱️ *Bulk Delay*: *${min}-${max}ms* antar batch/aksi grup.`);
}

export { pluginConfig as config, handler };
