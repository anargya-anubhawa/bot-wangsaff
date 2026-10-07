/**
 * GX-ID — `.xmpp` (Minecraft bridge control)
 *
 * Manages the WhatsApp ↔ Minecraft bridge created in `lib/xmpp/`:
 *
 *   .xmpp              → status overview
 *   .xmpp status       → connection status
 *   .xmpp groups       → list bridge groups
 *   .xmpp on           → enable the bridge        (owner)
 *   .xmpp off          → disable the bridge       (owner)
 *   .xmpp setgroup     → bridge THIS group         (owner / group admin)
 *   .xmpp unsetgroup   → un-bridge THIS group      (owner / group admin)
 *
 * Permissions reuse the existing access system (`lib/access.js`): read-only
 * subcommands are open to everyone, while configuration is limited to the owner
 * and group admins — no bespoke permission layer is introduced.
 */
import config from "../../config.js";
import { isOwner, isGroupAdmin } from "../../lib/access.js";
import { getDatabase } from "../../lib/database.js";
import { sendFeedback } from "../../lib/messages.js";
import {
  getBridgeGroups,
  setBridgeEnabled,
  addBridgeGroup,
  removeBridgeGroup,
  getXmppStatus,
} from "../../lib/xmpp/manager.js";

const pluginConfig = {
  name: "xmpp",
  alias: ["mc", "mcbridge"],
  category: "owner",
  description: "Kelola bridge WhatsApp ↔ Minecraft (XMPP)",
  usage: ".xmpp [status|groups|on|off|setgroup|unsetgroup]",
  examples: [".xmpp", ".xmpp status", ".xmpp on", ".xmpp setgroup"],
  helpOnEmpty: false,
  permission: "all",
  cooldown: 3,
  isEnabled: true,
};

/** Best-effort display name for a group JID (never throws). */
function groupName(jid) {
  try {
    const db = getDatabase();
    const group = db.getGroup(jid);
    if (group?.name) return group.name;
    const reg = db.getRegistration?.(jid);
    if (reg?.name) return reg.name;
  } catch {
    /* ignore */
  }
  return jid;
}

function statusEmoji(status) {
  switch (status) {
    case "AUTHENTICATED":
    case "CONNECTED":
      return "🟢";
    case "CONNECTING":
    case "RECONNECTING":
      return "🟡";
    case "ERROR":
      return "🔴";
    default:
      return "⚪";
  }
}

function statusText() {
  const s = getXmppStatus();
  const lines = [
    `⚙️ *XMPP Bridge*`,
    "",
    `> Status  : ${statusEmoji(s.status)} *${s.status}*`,
    `> Bridge  : *${s.enabled ? "aktif" : "nonaktif"}*`,
  ];
  if (s.server) lines.push(`> Server  : \`${s.server}\``);
  if (s.account) lines.push(`> Account : \`${s.account}\``);
  if (s.room) lines.push(`> Room    : \`${s.room}\``);
  else if (s.target) lines.push(`> Target  : \`${s.target}\``);
  return lines.join("\n");
}

function groupsText() {
  const groups = getBridgeGroups();
  if (!groups.length) {
    return "📭 *Belum ada grup bridge.*\n\nGunakan `.xmpp setgroup` di dalam grup yang ingin di-bridge.";
  }
  const lines = ["🌉 *Grup Bridge XMPP*", ""];
  groups.forEach((jid, i) => lines.push(`${i + 1}. ${groupName(jid)}`));
  return lines.join("\n");
}

/** Owner, or an admin acting inside the group they are bridging. */
function canConfigure(m) {
  if (m.fromMe) return true;
  if (isOwner(m.sender)) return true;
  return isGroupAdmin(m);
}

async function handler(m) {
  const sub = (m.args[0] || "").toLowerCase();

  /* read-only: available to everyone */
  if (!sub || sub === "status") {
    return m.reply(statusText());
  }

  if (sub === "groups" || sub === "list") {
    return m.reply(groupsText());
  }

  /* configuration: owner / group admin only */
  if (!canConfigure(m)) {
    return m.reply(
      `🔒 *Akses ditolak.*\n\n> Hanya owner atau admin grup yang dapat mengubah konfigurasi bridge.`,
    );
  }

  switch (sub) {
    case "on": {
      setBridgeEnabled(true);
      return m.reply("✅ *XMPP bridge diaktifkan.*");
    }

    case "off": {
      setBridgeEnabled(false);
      return m.reply("🛑 *XMPP bridge dinonaktifkan.*");
    }

    case "setgroup": {
      if (!m.isGroup) {
        return sendFeedback(m, config.messages?.groupOnlyExplicit || "❌ Perintah ini hanya dapat digunakan di dalam grup.");
      }
      const groups = addBridgeGroup(m.chat);
      return m.reply(
        `✅ *Grup ini ditambahkan ke bridge.*\n\n> ${groupName(m.chat)}\n> Total: *${groups.length}* grup`,
      );
    }

    case "unsetgroup": {
      if (!m.isGroup) {
        return sendFeedback(m, config.messages?.groupOnlyExplicit || "❌ Perintah ini hanya dapat digunakan di dalam grup.");
      }
      const before = getBridgeGroups();
      if (!before.includes(String(m.chat))) {
        return m.reply("ℹ️ *Grup ini bukan grup bridge.*");
      }
      const groups = removeBridgeGroup(m.chat);
      return m.reply(
        `🗑️ *Grup ini dihapus dari bridge.*\n\n> ${groupName(m.chat)}\n> Total: *${groups.length}* grup`,
      );
    }

    default:
      return m.reply(
        [
          "⚙️ *XMPP Bridge*",
          "",
          `> \`${m.prefix}xmpp\` — status`,
          `> \`${m.prefix}xmpp groups\` — daftar grup bridge`,
          `> \`${m.prefix}xmpp on|off\` — aktifkan/nonaktifkan (owner)`,
          `> \`${m.prefix}xmpp setgroup\` — jadikan grup ini bridge (owner/admin)`,
          `> \`${m.prefix}xmpp unsetgroup\` — hapus grup ini dari bridge (owner/admin)`,
        ].join("\n"),
      );
  }
}

/* referenced so a future status panel can show the configured target */
export { pluginConfig as config, handler };
