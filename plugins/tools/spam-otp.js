/**
 * GX-ID — /spamotp
 *
 * OTP-request helper (education / testing only). The send endpoints are NOT
 * hardcoded third-party services: they come from the plugin's own
 * `OTP_ENDPOINTS` list, which is empty by default. Until an operator fills it
 * in, the command explains that it is unconfigured.
 */
import axios from "axios";

/** Set these to your own OTP endpoints to enable the command. */
const OTP_ENDPOINTS = [];

const pluginConfig = {
  name: "spamotp",
  alias: ["otpspam"],
  category: "tools",
  description: "Kirim request OTP ke nomor target (edukasi)",
  usage: ".spamotp <nomor> <jumlah>",
  example: ".spamotp 628123456789 10",
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
  const count = Math.min(Math.max(parseInt(m.args?.[1], 10) || 10, 1), 100);

  if (!target) {
    return m.reply(`📱 *SPAM OTP*\n\n> Format: \`${m.prefix}${m.command} <nomor> <jumlah>\``);
  }

  if (!OTP_ENDPOINTS.length) {
    return m.reply(
      "⚙️ *Fitur belum dikonfigurasi.*\n\n" +
        "> Plugin ini butuh endpoint OTP sendiri.\n" +
        "> Isi `OTP_ENDPOINTS` di `plugins/tools/spam-otp.js` untuk mengaktifkan.",
    );
  }

  await m.react("🕕");

  let sent = 0;
  for (let i = 0; i < count; i++) {
    const endpoint = OTP_ENDPOINTS[i % OTP_ENDPOINTS.length];
    try {
      await axios.post(
        endpoint,
        {
          phone: target,
          type: "sms",
          app: ["wa", "telegram", "grab", "shopee"][i % 4],
          timestamp: Date.now(),
        },
        { timeout: 5000 },
      );
      sent++;
    } catch {
      /* count only successes */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  await m.react(sent ? "✅" : "❌");
  return m.reply(`📨 Selesai. *${sent}/${count}* OTP terkirim ke \`${target}\`.`);
}

export { pluginConfig as config, handler };
