/**
 * GX-ID — /banwa
 *
 * Mass-report helper (education / testing only). The report endpoint is NOT
 * hardcoded to a third-party service: it is read from the plugin's own
 * `REPORT_ENDPOINT` constant, which is empty by default. Until an operator
 * fills it in, the command explains that it is unconfigured instead of
 * firing requests at a placeholder host.
 */
import axios from "axios";

/** Set this to your own report endpoint to enable the command. */
const REPORT_ENDPOINT = "";

/** Number of reports fired per invocation. */
const REPORTS = 50;

const pluginConfig = {
  name: "banwa",
  alias: ["reportwa"],
  category: "tools",
  description: "Report massal akun/grup/channel WA (edukasi)",
  usage: ".banwa <nomor/link> <alasan>",
  example: ".banwa 628123456789 spam",
  isOwner: true,
  isPremium: false,
  isGroup: false,
  isPrivate: false,
  cooldown: 30,
  energi: 0,
  isEnabled: true,
};

async function handler(m) {
  const target = m.args?.[0]?.trim();
  const reason = m.args?.slice(1).join(" ") || "Spam/Abuse";

  if (!target) {
    return m.reply(`🚫 *BAN WA*\n\n> Format: \`${m.prefix}${m.command} <nomor/link> <alasan>\``);
  }

  if (!REPORT_ENDPOINT) {
    return m.reply(
      "⚙️ *Fitur belum dikonfigurasi.*\n\n" +
        "> Plugin ini butuh endpoint report sendiri.\n" +
        "> Isi `REPORT_ENDPOINT` di `plugins/tools/ban-wa.js` untuk mengaktifkan.",
    );
  }

  await m.react("🕕");

  let success = 0;
  for (let i = 0; i < REPORTS; i++) {
    try {
      await axios.post(
        REPORT_ENDPOINT,
        {
          target,
          reason,
          report_type: target.includes("chat.whatsapp.com")
            ? "group"
            : target.includes("channel")
              ? "channel"
              : "account",
          timestamp: Date.now(),
        },
        { timeout: 5000 },
      );
      success++;
    } catch {
      /* count only successes */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  await m.react(success ? "✅" : "❌");
  return m.reply(`📨 Selesai. *${success}/${REPORTS}* report terkirim ke \`${target}\`.`);
}

export { pluginConfig as config, handler };
