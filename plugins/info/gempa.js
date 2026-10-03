/**
 * GX-ID — /gempa
 *
 * Latest earthquake info from BMKG (Indonesian Meteorology agency), with the
 * shakemap image when available.
 */
import axios from "axios";
import { saluranCtx } from "../../lib/context.js";

const pluginConfig = {
  name: "gempa",
  alias: ["bmkg", "infogempa", "earthquake", "earthquakes"],
  category: "info",
  description: "Latest earthquake info from BMKG",
  usage: ".gempa",
  example: ".gempa",
  isOwner: false,
  isGroup: false,
  cooldown: 10,
  isEnabled: true,
};

async function handler(m, { sock }) {
  await m.react("🕕");
  try {
    const res = await axios.get("https://data.bmkg.go.id/DataMKG/TEWS/autogempa.json", { timeout: 15000 });
    const g = res.data?.Infogempa?.gempa;
    if (!g) throw new Error("No earthquake data available");

    const shakemapUrl = g.Shakemap ? `https://data.bmkg.go.id/DataMKG/TEWS/${g.Shakemap}` : null;

    const text =
      `🌍 *Latest Earthquake — BMKG*\n\n` +
      `> 📅 Date     : *${g.Tanggal}*\n` +
      `> 🕐 Time     : *${g.Jam}*\n` +
      `> 📐 Coord    : *${g.Coordinates}*\n` +
      `> 📍 Latitude : *${g.Lintang}*\n` +
      `> 📍 Longitude: *${g.Bujur}*\n` +
      `> 💥 Magnitude: *${g.Magnitude}*\n` +
      `> 🔽 Depth    : *${g.Kedalaman}*\n` +
      `> 🗺️ Region   : *${g.Wilayah}*\n` +
      `> ⚠️ Potential: *${g.Potensi}*\n` +
      `> 🏠 Felt     : *${g.Dirasakan || "-"}*\n\n` +
      `_Source: BMKG Indonesia_`;

    await m.react("✅");

    if (shakemapUrl) {
      try {
        const imgRes = await axios.get(shakemapUrl, { responseType: "arraybuffer", timeout: 15000 });
        await sock.sendMedia(m.chat, Buffer.from(imgRes.data), text, m.raw, { type: "image" });
        return;
      } catch {
        /* fall through to text */
      }
    }
    await m.reply(text, { contextInfo: saluranCtx() });
  } catch (error) {
    await m.react("☢");
    await m.reply(`❌ *Failed to fetch earthquake data.*\n\n> ${error.message || "Please try again later."}`);
  }
}

export { pluginConfig as config, handler };
