/**
 * GX-ID — /prefix (owner only)
 *
 * View or add custom prefixes. The config prefix is always active; extra
 * prefixes are stored in the database and merged by the serializer.
 */
import { invalidatePrefixCache } from "../../lib/serialize.js";

const pluginConfig = {
  name: "prefix",
  alias: ["setprefix", "prefixes"],
  category: "owner",
  description: "View or set command prefixes",
  usage: ".prefix [add|del] <char>",
  example: ".prefix add !",
  helpOnEmpty: false,
  isOwner: true,
  cooldown: 3,
  isEnabled: true,
};

async function handler(m, { db, config }) {
  const base = config.command?.prefix || ".";
  const extras = db.setting("prefixes") || [];
  const action = (m.args[0] || "").toLowerCase();
  const char = m.args[1];

  if (!action) {
    const all = [base, ...extras];
    return m.reply(`⚙️ *Prefixes*\n\n> Active: ${all.map((p) => `\`${p}\``).join(", ")}\n\n> Add: \`${base}prefix add <char>\`\n> Remove: \`${base}prefix del <char>\``);
  }

  if (!char || char.length > 2) {
    return m.reply("❌ Provide a prefix character (max 2 chars).");
  }

  let list = Array.isArray(extras) ? [...extras] : [];
  if (action === "add") {
    if (list.includes(char)) return m.reply(`⚠️ Prefix \`${char}\` already exists.`);
    list.push(char);
  } else if (action === "del" || action === "remove") {
    if (!list.includes(char)) return m.reply(`⚠️ Prefix \`${char}\` is not a custom prefix.`);
    list = list.filter((p) => p !== char);
  } else {
    return m.reply("❌ Unknown action. Use `add` or `del`.");
  }

  db.setting("prefixes", list);
  invalidatePrefixCache();
  await m.reply(`✅ *Prefixes updated.*\n\n> Active: ${[base, ...list].map((p) => `\`${p}\``).join(", ")}`);
}

export { pluginConfig as config, handler };
