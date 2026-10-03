/**
 * GX-ID — /spampairing
 *
 * Pairing-code request helper (education / testing only). The endpoint is NOT
 * hardcoded to a third-party service: it comes from the plugin's own
 * `PAIRING_ENDPOINT` constant, which is empty by default. Until an operator
 * fills it in, the command explains that it is unconfigured.
 */
import axios from "axios";

/** Set this to your own pairing endpoint to enable the command. */
const PAIRING_ENDPOINT = "";

const pluginConfig = {
  name: "spampairing",
  alias: ["pairingspam"],
  category: "tools",
  description: "Kirim request pairing code ke nomor WA target (edukasi)",
  usage: ".spampairing <nomor> <jumlah>",
  example: ".spampairing 628123456789 5",
  isOwner: true,
  isPremium: false,
  isGroup: false,
  isPrivate: false,
  cooldown: 30,
  energi: 0,
  isEnabled: true,
};

async function handler(m) {
  const target = m.args?.[0]?.replace(/[^0-9]/g, "");
  const count = Math.min(Math.max(parseInt(m.args?.[1], 10) || 5, 1), 100);

  if (!target) {
    return m.reply(`🔗 *SPAM PAIRING*\n\n> Format: \`${m.prefix}${m.command} <nomor> <jumlah>\``);
  }

  if (!PAIRING_ENDPOINT) {
    return m.reply(
      "⚙️ *Fitur belum dikonfigurasi.*\n\n" +
        "> Plugin ini butuh endpoint pairing sendiri.\n" +
        "> Isi `PAIRING_ENDPOINT` di `plugins/tools/spam-pairing.js` untuk mengaktifkan.",
    );
  }

  await m.react("🕕");

  let sent = 0;
  for (let i = 0; i < count; i++) {
    try {
      await axios.post(
        PAIRING_ENDPOINT,
        { phone: target, method: "pairing_code", timestamp: Date.now() },
        { timeout: 5000 },
      );
      sent++;
    } catch {
      /* count only successes */
    }
    await new Promise((r) => setTimeout(r, 1500));
  }

  await m.react(sent ? "✅" : "❌");
  return m.reply(`📨 Selesai. *${sent}/${count}* request pairing terkirim ke \`${target}\`.`);
}

export { pluginConfig as config, handler };
