/**
 * Helper bersama untuk STIKER SUARA (sound sticker WhatsApp), dipakai `.sa`.
 *
 * Port dari RESBOT (lib/stickerSuara.js). Bentuk pesannya:
 * `{ stickerMessage: { ...media webp, audioMessage: {...} } }` — sudah diuji
 * di WhatsApp sungguhan. Media diunggah manual lewat `sock.waUploadToServer`
 * (Baileys) lalu dikirim sebagai proto mentah.
 */

import webpmux from "node-webpmux";
import { downloadContentFromMessage } from "@whiskeysockets/baileys";

import { ingatStikerSuara } from "./stickerAudioCache.js";

const webp = webpmux.default || webpmux;

export const MIME_AUDIO_STIKER = "audio/ogg; codecs=opus";

/** Field hasil upload -> field media di proto. */
export function fieldMedia(up, mimetype) {
  return {
    url: up.url,
    directPath: up.directPath,
    mediaKey: up.mediaKey,
    fileSha256: up.fileSha256,
    fileEncSha256: up.fileEncSha256,
    fileLength: up.fileLength,
    mediaKeyTimestamp: up.mediaKeyTimestamp,
    mimetype,
  };
}

/** audioMessage dari stiker suara yang sudah ada (tanpa contextInfo). */
export function audioDariStiker(stickerMessage) {
  return bersihkanAudio(stickerMessage?.audioMessage);
}

export function bersihkanAudio(audio) {
  if (!audio) return null;
  if (!audio.mediaKey || !(audio.directPath || audio.url)) return null;
  const { contextInfo: _buang, ...bersih } = audio;
  return bersih;
}

/**
 * Unduh audio dari stiker suara lama, lalu unggah ulang dengan kunci baru
 * (jalur yang sama dengan `.sa`, sudah terbukti bersuara).
 */
export async function unggahUlangAudio(sock, remoteJid, audioLama) {
  if (!remoteJid || !audioLama?.mediaKey) throw new Error("Suara stiker tidak bisa diunduh.");
  const stream = await downloadContentFromMessage(audioLama, "audio");
  const chunk = [];
  for await (const c of stream) chunk.push(c);
  const buffer = Buffer.concat(chunk);

  const mimetype = audioLama.mimetype || MIME_AUDIO_STIKER;
  const up = await sock.waUploadToServer(buffer, { type: "audio", mimetype });
  return {
    ...fieldMedia(up, mimetype),
    seconds: audioLama.seconds ?? undefined,
    ptt: false,
    ...(up.streamingSidecar ? { streamingSidecar: up.streamingSidecar } : {}),
  };
}

/** Ukuran asli webp (stiker .wm bisa non-512). */
async function ukuranWebp(webpBuffer) {
  try {
    const img = new webp.Image();
    await img.load(webpBuffer);
    if (img.width > 0 && img.height > 0) return { width: img.width, height: img.height };
  } catch {
    /* tidak terbaca -> ukuran standar */
  }
  return { width: 512, height: 512 };
}

/**
 * Unggah webp stiker lalu kirim sebagai stiker suara.
 * @param {object} opsi.langkah pembungkus timeout+log (dipakai .sa)
 */
export async function kirimStikerSuara(
  sock,
  remoteJid,
  { webpBuffer, isAnimated, audioMessage, quoted, langkah = (_n, _ms, fn) => fn() },
) {
  const upSticker = await langkah("upload stiker", 60_000, () =>
    sock.waUploadToServer(webpBuffer, { type: "sticker", mimetype: "image/webp" }),
  );

  const stickerMessage = {
    ...fieldMedia(upSticker, "image/webp"),
    ...(await ukuranWebp(webpBuffer)),
    isAnimated: !!isAnimated,
    audioMessage,
  };

  const hasil = await langkah("kirim stiker suara", null, () =>
    sock.sendMessage(remoteJid, { stickerMessage }, quoted ? { quoted } : {}),
  );

  ingatStikerSuara(remoteJid, hasil?.key?.id, audioMessage);
  return hasil;
}
