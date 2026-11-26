/**
 * Helper bersama untuk STIKER SUARA (sound sticker WhatsApp), dipakai `.sa`.
 *
 * Bentuk pesannya: `{ stickerMessage: { ...media webp, audioMessage: {...} } }`.
 * Media di-upload lewat `sock.prepareMedia` (= `prepareWAMessageMedia` Baileys),
 * yang mengisi sendiri directPath/mediaKey/fileSha256/url, lalu dikirim sebagai
 * proto mentah. (Tidak memakai `waUploadToServer` langsung: signature Baileys-nya
 * `(filePath, { mediaType, fileEncSha256B64 })`, beda dengan zapo.)
 */

import webpmux from "node-webpmux";
import {
  downloadContentFromMessage,
  generateMessageIDV2,
  normalizeMessageContent,
  getContentType,
  proto,
  jidNormalizedUser,
} from "@whiskeysockets/baileys";

import { ingatStikerSuara } from "./stickerAudioCache.js";
import { patchStickerAudio } from "./patchStickerAudio.js";

// Aktifkan dukungan audioMessage pada StickerMessage (sound sticker).
patchStickerAudio();

const webp = webpmux.default || webpmux;

export const MIME_AUDIO_STIKER = "audio/ogg; codecs=opus";

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

/** Ukuran asli webp (stiker bisa non-512). */
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
 * Siapkan audioMessage dari buffer ogg/opus via prepareMedia.
 * @returns {Promise<object>} audioMessage siap ditempel ke stiker
 */
async function siapkanAudio(sock, remoteJid, audioBuffer, seconds, langkah) {
  const prepared = await langkah("upload audio", 60_000, () =>
    sock.prepareMedia(
      {
        audio: audioBuffer,
        mimetype: MIME_AUDIO_STIKER,
        ptt: false,
        seconds: seconds ?? undefined,
      },
      { jid: remoteJid },
    ),
  );
  const audioMessage = prepared?.audioMessage;
  if (!audioMessage) throw new Error("Gagal menyiapkan audio stiker.");
  return { ...audioMessage, ptt: false };
}

/**
 * Unggah webp stiker + audio lalu kirim sebagai stiker suara.
 * @param {object} opsi.langkah pembungkus timeout+log (dipakai .sa)
 */
export async function kirimStikerSuara(
  sock,
  remoteJid,
  { webpBuffer, isAnimated, audioBuffer, seconds, quoted, langkah = (_n, _ms, fn) => fn() },
) {
  const audioMessage = await siapkanAudio(sock, remoteJid, audioBuffer, seconds, langkah);

  const preparedSticker = await langkah("upload stiker", 60_000, () =>
    sock.prepareMedia(
      { sticker: webpBuffer, isAnimated: !!isAnimated },
      { jid: remoteJid },
    ),
  );
  const base = preparedSticker?.stickerMessage;
  if (!base) throw new Error("Gagal menyiapkan stiker.");

  const ukuran = await ukuranWebp(webpBuffer);
  const stickerMessage = {
    ...base,
    ...ukuran,
    isAnimated: !!isAnimated,
    audioMessage,
    mimetype: "image/webp",
  };

  // Quoting: contextInfo ditempel langsung (relayMessage tidak menerima opsi
  // `quoted`, dan generateWAMessageFromContent memanggil Message.create yang
  // membuang `audioMessage`). Salin contextInfo dari proto quoted apa adanya.
  if (quoted) {
    const qMsg = normalizeMessageContent(quoted.message) || quoted.message || {};
    const qType = getContentType(qMsg);
    let quotedMsg = qMsg;
    if (qType) {
      quotedMsg = proto.Message.create({ [qType]: qMsg[qType] });
      const qContent = quotedMsg[qType];
      if (qContent && typeof qContent === "object" && "contextInfo" in qContent) {
        delete qContent.contextInfo;
      }
    }
    const participant = quoted.key?.fromMe
      ? sock.user?.id
      : quoted.participant || quoted.key?.participant || quoted.key?.remoteJid;
    stickerMessage.contextInfo = {
      participant: jidNormalizedUser(participant),
      stanzaId: quoted.key?.id,
      quotedMessage: quotedMsg,
    };
  }

  // Kirim sebagai proto mentah lewat relayMessage. encodeWAMessage memakai
  // proto.Message.encode (yang sudah ditambal patchStickerAudio), sehingga
  // audioMessage ikut ter-encode. (sendMessage/generateWAMessageFromContent
  // TIDAK dipakai: keduanya memanggil Message.create yang membuang audioMessage,
  // dan sendMessage balas "Invalid media type" untuk proto stickerMessage.)
  const messageId = generateMessageIDV2(sock.user?.id);
  const hasil = await langkah("kirim stiker suara", null, async () => {
    await sock.relayMessage(remoteJid, { stickerMessage }, { messageId });
    return { key: { id: messageId, remoteJid } };
  });

  ingatStikerSuara(remoteJid, hasil?.key?.id, audioMessage);
  return hasil;
}

/**
 * Unduh audio dari stiker suara lama, lalu siapkan audioMessage baru.
 * (Untuk fitur lanjutan seperti `.wm`.)
 */
export async function unggahUlangAudio(sock, remoteJid, audioLama) {
  if (!remoteJid || !audioLama?.mediaKey) throw new Error("Suara stiker tidak bisa diunduh.");
  const stream = await downloadContentFromMessage(audioLama, "audio");
  const chunk = [];
  for await (const c of stream) chunk.push(c);
  const buffer = Buffer.concat(chunk);
  const { audioMessage } = await siapkanAudio(
    sock,
    remoteJid,
    buffer,
    audioLama.seconds ?? undefined,
    (_n, _ms, fn) => fn(),
  );
  return audioMessage;
}
