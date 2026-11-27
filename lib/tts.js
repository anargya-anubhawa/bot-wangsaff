/**
 * TTS minimal — teks -> Buffer audio (mp3), dipakai `.sa` (stiker suara).
 *
 * VEA tidak punya `.vn`/getVoiceBuffer seperti bot lain, jadi di sini
 * dipakai Google Translate TTS (tanpa API key). Dipotong per ±200 karakter
 * (batas endpoint), lalu potongan digabung.
 */
import axios from "axios";

const BATAS_KARAKTER = 200;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

async function ambilSatu(teks) {
  const { data } = await axios.get("https://translate.google.com/translate_tts", {
    params: { ie: "UTF-8", q: teks, tl: "id", client: "tw-ob" },
    headers: { "User-Agent": UA },
    responseType: "arraybuffer",
    timeout: 20000,
  });
  return Buffer.from(data);
}

/** @returns {Promise<Buffer|null>} mp3 audio, atau null bila gagal */
export async function getVoiceBuffer(text) {
  const bersih = String(text || "").trim();
  if (!bersih) return null;

  const potongan = [];
  for (let i = 0; i < bersih.length; i += BATAS_KARAKTER) {
    potongan.push(bersih.slice(i, i + BATAS_KARAKTER));
  }

  try {
    const hasil = await Promise.all(potongan.map(ambilSatu));
    const gabung = Buffer.concat(hasil);
    return gabung.length ? gabung : null;
  } catch {
    return null;
  }
}
