/**
 * Ingatan singkat untuk `.sa`: VN/audio mana yang membalas stiker/gambar apa,
 * dan stiker suara mana yang pernah lewat.
 *
 * Port dari RESBOT (lib/stickerAudioCache.js) — perilaku sama, hanya lapisan
 * resolve pesan memakai `normalizeMessageContent`/`getContentType` Baileys
 * (VEA) alih-alih `resolveMessage`/`extractMedia` milik RESBOT.
 */

import { normalizeMessageContent, getContentType } from "@whiskeysockets/baileys";
import { createBoundedMap } from "./boundedStore.js";

const MEDIA_TYPE_MAP = {
  imageMessage: "image",
  videoMessage: "video",
  audioMessage: "audio",
  stickerMessage: "sticker",
  documentMessage: "document",
};

/** Jenis media yang bisa dijadikan sumber visual stiker bersuara. */
const JENIS_VISUAL = new Set(["sticker", "image", "video"]);

const ingatan = createBoundedMap({ max: 1000, ttl: 6 * 60 * 60 * 1000 });

/** Ekstensi file audio yang dikenali bila dikirim sebagai DOKUMEN. */
const EKSTENSI_AUDIO = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|amr|wma|3gp)$/i;

/** Buka wrapper message (ephemeral/viewOnce/dll) -> objek content media. */
function resolveContent(input) {
  const raw = input?.message ? input.message : input;
  if (!raw || typeof raw !== "object") return null;
  return normalizeMessageContent(raw) || raw;
}

/** @returns {{ mediaType: string, mediaMessage: object } | null} */
function extractMedia(input) {
  const content = resolveContent(input);
  if (!content || typeof content !== "object") return null;
  for (const [field, mediaType] of Object.entries(MEDIA_TYPE_MAP)) {
    if (content[field]) return { mediaType, mediaMessage: content[field] };
  }
  return null;
}

/** contextInfo dari jenis pesan apa pun (image/video/sticker/audio/...). */
function getContextInfo(input) {
  const content = resolveContent(input);
  if (!content || typeof content !== "object") return null;
  for (const key of Object.keys(content)) {
    const ci = content[key]?.contextInfo;
    if (ci) return ci;
  }
  return null;
}

/**
 * Jenis media versi `.sa`: file audio yang dikirim sebagai DOKUMEN (mis. lagu
 * .mp3 lewat "Dokumen") dianggap 'audio', bukan 'document'.
 */
function mediaSa(content) {
  const media = extractMedia(content);
  if (media?.mediaType !== "document") return media;
  const m = media.mediaMessage || {};
  const audio = /^audio\//i.test(m.mimetype || "") || EKSTENSI_AUDIO.test(m.fileName || "");
  return audio ? { ...media, mediaType: "audio" } : media;
}

const kunci = (remoteJid, id) => `${remoteJid}|${id}`;

/** Stiker/gambar yang dibalas sebuah pesan audio. */
function visualDibalasAudio(audioContent) {
  const media = mediaSa(audioContent);
  if (media?.mediaType !== "audio") return null;

  const ctx = media.mediaMessage?.contextInfo ?? getContextInfo(audioContent);
  const quoted = ctx?.quotedMessage;
  if (!quoted) return null;

  const visual = extractMedia(quoted);
  if (!visual || !JENIS_VISUAL.has(visual.mediaType)) return null;
  const m = visual.mediaMessage;
  if (!m?.mediaKey || !(m.directPath || m.url)) return null;

  return { quoted, stanzaId: ctx.stanzaId, participant: ctx.participant };
}

/** Dipanggil pipeline untuk SETIAP pesan masuk audio/dokumen. */
function ingatVisualDibalasVN(remoteJid, message) {
  const id = message?.key?.id;
  if (!remoteJid || !id) return;
  const hasil = visualDibalasAudio(message);
  if (hasil) ingatan.set(kunci(remoteJid, id), hasil);
}

function cariVisualDibalasVN(remoteJid, idVN) {
  if (!remoteJid || !idVN) return null;
  return ingatan.get(kunci(remoteJid, idVN)) ?? null;
}

/* ---- pilihan dua langkah (visual + audio yang tidak saling membalas) ---- */

const MASA_PILIHAN = 60 * 1000;
const pilihan = createBoundedMap({ max: 500, ttl: MASA_PILIHAN });

function simpanPilihan(remoteJid, user, jenis, media) {
  pilihan.set(kunci(remoteJid, user), { jenis, ...media });
}

function ambilPilihan(remoteJid, user) {
  return pilihan.get(kunci(remoteJid, user)) ?? null;
}

function hapusPilihan(remoteJid, user) {
  pilihan.delete(kunci(remoteJid, user));
}

/* ---- ingatan stiker suara yang pernah lewat (untuk .wm) ---- */

const stikerSuara = createBoundedMap({ max: 1000, ttl: 6 * 60 * 60 * 1000 });

function ingatStikerSuara(remoteJid, id, audioMessage) {
  if (!remoteJid || !id || !audioMessage) return;
  stikerSuara.set(kunci(remoteJid, id), audioMessage);
}

function cariStikerSuara(remoteJid, id) {
  if (!remoteJid || !id) return null;
  return stikerSuara.get(kunci(remoteJid, id)) ?? null;
}

/** Catat stiker suara yang masuk. */
function ingatStikerSuaraMasuk(remoteJid, message) {
  const media = extractMedia(message);
  if (media?.mediaType !== "sticker") return;
  const audio = media.mediaMessage?.audioMessage;
  if (audio?.mediaKey) ingatStikerSuara(remoteJid, message?.key?.id, audio);
}

export {
  mediaSa,
  extractMedia,
  getContextInfo,
  ingatStikerSuara,
  cariStikerSuara,
  ingatStikerSuaraMasuk,
  visualDibalasAudio,
  ingatVisualDibalasVN,
  cariVisualDibalasVN,
  simpanPilihan,
  ambilPilihan,
  hapusPilihan,
  MASA_PILIHAN,
};
