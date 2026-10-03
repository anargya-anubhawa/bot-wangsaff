/**
 * GX-ID — /logs (owner/whitelist)
 *
 * Shows recent moderation/message events from the persistent event log, with
 * the configured retention. Optional filters:
 *
 *   .logs                       → latest events
 *   .logs <grup>                → latest events for a group (alias or id)
 *   .logs <n>                   → latest n events
 *   .logs retention <1-365>     → set the retention window (days)
 */
import { resolveGroup, ALIAS_NOT_FOUND_MESSAGE } from "../../lib/group-registry.js";
import { getLogRetentionDays, pruneEventLogs, setLogRetentionDays } from "../../lib/moderation-log.js";

const pluginConfig = {
  name: "logs",
  alias: ["eventlog", "riwayatlog"],
  category: "group-setup",
  description: "Tampilkan riwayat log moderasi terbaru",
  usage: ".logs [grup|jumlah]  |  .logs retention <hari>",
  examples: [".logs", ".logs 20", ".logs kelas-a", ".logs retention 30"],
  helpOnEmpty: false,
  permission: "owner",
  cooldown: 3,
  isEnabled: true,
};

const ACTION_LABEL = { delete: "DELETED", revoked: "REVOKED", rvo: "RVO", report: "REPORTED", filter: "FILTER" };

async function handler(m, { db, config }) {
  const prefix = m.prefix || config.command?.prefix || ".";
  const arg = m.args?.[0];
  const second = m.args?.[1];

  /* `.logs retention <days>` sets the retention window */
  if (String(arg || "").toLowerCase() === "retention") {
    const days = Number(second);
    if (!Number.isFinite(days) || days < 1 || days > 365) {
      return m.reply(
        `🗂️ *Retensi log* saat ini: *${getLogRetentionDays()} hari*.\n\n> Ubah: \`${prefix}logs retention <1-365>\``,
      );
    }
    setLogRetentionDays(days);
    return m.reply(`✅ Retensi log diset ke *${days} hari*.`);
  }

  let groupId = null;
  let limit = 15;
  if (arg) {
    if (/^\d+$/.test(arg)) {
      limit = Math.min(50, Math.max(1, Number(arg)));
    } else {
      const group = resolveGroup(arg);
      if (!group) return m.reply(ALIAS_NOT_FOUND_MESSAGE);
      groupId = group.groupId;
    }
  }

  pruneEventLogs();
  const events = db.listEventLogs(limit, groupId ? { groupId } : {});
  if (!events.length) {
    return m.reply(`🗂️ *Belum ada log.*\n\n> Retensi: ${getLogRetentionDays()} hari.`);
  }

  const lines = events.map((e) => {
    const time = String(e.createdAt || "").replace("T", " ").slice(0, 16);
    const who = e.actorId ? `@${String(e.actorId).split("@")[0]}` : "-";
    const group = e.groupAlias || (e.groupId ? String(e.groupId).split("@")[0] : "-");
    return `┃ ${time} · ${ACTION_LABEL[e.action] || e.action}${e.reason ? `/${e.reason}` : ""} · ${group} · ${who}`;
  });

  await m.reply(
    `🗂️ *Log Moderasi* (${events.length})\n\n╭─〔 event log 〕\n${lines.join("\n")}\n╰─⬣\n\n> Retensi: ${getLogRetentionDays()} hari.`,
  );
}

export { pluginConfig as config, handler };
