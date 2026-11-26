/**
 * .sa — Sticker Audio (sound sticker WhatsApp).
 *
 * Cara pakai (urutan sama dengan teksBantuan: dari yang paling mudah):
 *  1. Kirim GAMBAR dengan caption `.sa <teks>`, atau balas gambar/stiker dengan
 *     `.sa <teks>` -> suaranya dibuat dari teks (Google TTS, lihat lib/tts.js).
 *  2. Stiker/gambar dan VN/audio yang sudah ada di chat tapi TIDAK saling
 *     membalas: balas salah satunya dengan `.sa` (dipilih & diingat 1 menit),
 *     lalu balas yang lain dengan `.sa` -> digabung. Urutan bebas.
 *     `.sa batal` menghapus pilihan.
 *  3. Balas dengan `.sa` sebuah VN/audio yang SENDIRINYA membalas stiker atau
 *     gambar -> stiker/gambar itu + suara VN-nya. Stiker yang dibalas VN dicari
 *     di pesan itu sendiri, atau dari ingatan (core/message.js mencatatnya,
 *     lihat lib/stickerAudioCache.js).
 *  4. BALAS sebuah VN/audio sambil melampirkan GAMBAR dengan caption `.sa`
 *     -> stiker dari gambar itu + suara dari VN/audio yang dibalas.
 *     (WhatsApp mengizinkan membalas pesan dengan media: geser VN-nya, lalu
 *     lampirkan gambar.)
 *
 * "VN/audio" di atas juga mencakup file audio yang dikirim sebagai DOKUMEN
 * (mis. lagu .mp3 lewat menu File) — lihat mediaSa di lib/stickerAudioCache.js.
 *
 * Tanpa APIKEY semua cara tetap jalan: suara teks langsung memakai Google TTS.
 *
 * VIDEO/GIF diperlakukan seperti gambar (sumber visual), hanya saja hasilnya
 * stiker animasi (maks DURASI_MAKS detik) dan suara bawaannya adalah suara
 * video itu sendiri. Urutan sumber suara untuk video:
 *   VN yang dibalas / VN yang sudah dipilih -> teks `.sa <teks>` (TTS)
 *   -> suara video itu sendiri.
 *
 * Hasilnya stiker yang berbunyi saat diputar (fitur "sound sticker" WhatsApp).
 *
 * Cara mengirim stiker suaranya (upload manual + proto mentah) ada di
 * lib/stickerSuara.js.
 *
 * Catatan: penerima hanya mendengar suaranya bila WhatsApp-nya sudah mendapat
 * fitur sound sticker (masih bertahap / di-rollout lewat AB props). Di klien
 * lama tampil sebagai stiker biasa tanpa suara.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import ff from 'fluent-ffmpeg';
import { path as ffmpegPath } from '@ffmpeg-installer/ffmpeg';
import webpmux from 'node-webpmux';
import { downloadContentFromMessage } from '@whiskeysockets/baileys';

import config from '../../config.js';
import { getDatabase } from '../../lib/database.js';
import { isOwner } from '../../lib/access.js';
import { imageToWebpFFmpeg, videoToWebpFFmpeg, addExifToWebp } from '../../src/lib/GX-exif.js';
import { downloadMedia } from '../../lib/media.js';
import { getVoiceBuffer } from '../../lib/tts.js';
import {
  mediaSa,
  extractMedia,
  getContextInfo,
  visualDibalasAudio,
  cariVisualDibalasVN,
  simpanPilihan,
  ambilPilihan,
  hapusPilihan,
  MASA_PILIHAN,
} from '../../lib/stickerAudioCache.js';
import { fieldMedia, kirimStikerSuara, MIME_AUDIO_STIKER as MIME_AUDIO } from '../../lib/stickerSuara.js';

ff.setFfmpegPath(ffmpegPath);

const webp = webpmux.default || webpmux;

/**
 * Durasi maksimal suara stiker (detik); audio yang lebih panjang dipotong.
 * Sama dengan potongan videoToWebpFFmpeg (default 5 detik), supaya suara
 * dari video pas dengan gambarnya.
 */
const DURASI_MAKS = 5;

/**
 * Stiker dari GAMBAR dibuat sebagai webp ANIMASI (2 frame identik) alih-alih
 * stiker diam. Stiker suara resmi WhatsApp berasal dari klip animasi, dan
 * belum pasti klien mau memutar suara pada stiker diam. Kalau ternyata stiker
 * diam juga bersuara, boleh diganti false.
 */
const GAMBAR_ANIMASI = true;

function fileSementara(ext) {
  return path.join(os.tmpdir(), `sa_${crypto.randomBytes(6).toString('hex')}.${ext}`);
}

function hapus(...files) {
  for (const f of files) {
    if (typeof f !== 'string') continue;
    try {
      fs.unlinkSync(f);
    } catch {
      // sudah tidak ada
    }
  }
}

/**
 * Ubah VN/audio/TTS -> ogg/opus mono (format voice WhatsApp), dipotong
 * DURASI_MAKS detik. `noVideo` membuang cover art yang sering ada di mp3.
 * @param {string} label subjek untuk pesan error, mis. "Audio itu"
 * @returns {Promise<{ file: string, seconds: number }>}
 */
function ekstrakAudio(inputPath, label) {
  const out = fileSementara('ogg');
  let durasiInput = 0;
  const bisu = () => new Error(`${label} tidak punya suara.`);

  return new Promise((resolve, reject) => {
    // timeout ffmpeg (detik) < batas langkah (60 dtk): ffmpeg yang macet
    // DIBUNUH dan berkas keluarannya dihapus di handler 'error', alih-alih
    // terus berjalan dan meninggalkan .ogg yatim di folder temp.
    ff(inputPath, { timeout: 50 })
      .noVideo()
      .audioCodec('libopus')
      .audioChannels(1)
      .audioFrequency(48000)
      .audioBitrate('64k')
      .duration(DURASI_MAKS)
      .format('ogg')
      .on('codecData', (data) => {
        const [h = 0, m = 0, s = 0] = String(data?.duration || '0')
          .split(':')
          .map(Number);
        durasiInput = h * 3600 + m * 60 + s;
      })
      .on('error', (err) => {
        hapus(out);
        const pesan = String(err?.message || err);
        reject(/does not contain any stream|matches no streams|no audio/i.test(pesan) ? bisu() : err);
      })
      .on('end', () => {
        if (!fs.existsSync(out) || fs.statSync(out).size === 0) {
          hapus(out);
          return reject(bisu());
        }
        const seconds = Math.max(
          1,
          Math.round(durasiInput ? Math.min(durasiInput, DURASI_MAKS) : DURASI_MAKS),
        );
        resolve({ file: out, seconds });
      })
      .save(out);
  });
}

const metaPaket = () => ({
  packname: config.sticker?.packname || 'GX-ID',
  author: config.sticker?.author || 'GX-ID',
});

/**
 * Gambar -> webp stiker 512x512. Bila GAMBAR_ANIMASI, dibungkus jadi animasi
 * 2 frame sepanjang durasi audio — imageToWebpFFmpeg lalu node-webpmux.
 */
async function stikerDariGambar(imagePath, detikAudio) {
  const statis = await imageToWebpFFmpeg(fs.readFileSync(imagePath));

  let webpBuffer = statis;
  if (GAMBAR_ANIMASI) {
    const frame = await webp.Image.generateFrame({
      buffer: statis,
      delay: Math.round((detikAudio * 1000) / 2),
    });
    webpBuffer = await webp.Image.save(null, {
      width: 512,
      height: 512,
      frames: [frame, { ...frame }],
      loops: 0,
      bgColor: [0, 0, 0, 0],
    });
  }

  return { ...(await pasangPaket(webpBuffer)), isAnimated: GAMBAR_ANIMASI };
}

/**
 * Webp -> webp dengan paket stiker bot (EXIF dari config.sticker.packname /
 * author, sama seperti .sticker). EXIF lama (paket milik orang lain)
 * diganti. addExifToWebp menyisipkannya di level chunk, jadi frame animasi &
 * transparansinya tidak disentuh.
 */
async function pasangPaket(webpBuffer) {
  const packed = await addExifToWebp(webpBuffer, metaPaket());
  return { webpBuffer: packed?.length ? packed : webpBuffer };
}

/**
 * Stiker yang sudah ada -> stiker bersuara.
 * Stiker animasi: frame-nya dipakai apa adanya, hanya paketnya diganti paket
 * bot. Stiker diam diperlakukan seperti gambar (dibungkus animasi bila
 * GAMBAR_ANIMASI).
 */
async function stikerDariStiker(stickerPath, detikAudio) {
  const buffer = fs.readFileSync(stickerPath);
  const img = new webp.Image();
  try {
    await img.load(buffer);
  } catch {
    // Bukan webp yang bisa dibaca -> coba jalur gambar biasa.
    return stikerDariGambar(stickerPath, detikAudio);
  }
  if (img.hasAnim) return { ...(await pasangPaket(buffer)), isAnimated: true };
  return stikerDariGambar(stickerPath, detikAudio);
}

/**
 * Video/GIF -> stiker animasi 512x512 (dipotong 5 detik oleh videoToWebpFFmpeg,
 * jalur yang sama dengan .sticker untuk video) + paket stiker bot.
 */
async function stikerDariVideo(videoPath) {
  const webpBuffer = await videoToWebpFFmpeg(fs.readFileSync(videoPath));
  if (!webpBuffer?.length) throw new Error('Gagal mengubah video menjadi stiker.');
  return { ...(await pasangPaket(webpBuffer)), isAnimated: true };
}

/**
 * Stiker/gambar yang dibalas oleh VN yang dibalas pesan ini (skenario 4).
 * Dicari di quotedMessage itu sendiri dulu, lalu di ingatan handler.
 * @returns {{ quoted: object, stanzaId?: string, participant?: string, jenis: string } | null}
 */
function visualBersarang(message, remoteJid) {
  const ctx = getContextInfo(message);
  if (!ctx?.quotedMessage) return null;
  const hasil = visualDibalasAudio(ctx.quotedMessage) ?? cariVisualDibalasVN(remoteJid, ctx.stanzaId);
  if (!hasil) return null;
  return { ...hasil, jenis: extractMedia(hasil.quoted)?.mediaType };
}

/**
 * Unduh media dari proto yang disimpan (stiker bersarang / pilihan dua
 * langkah) langsung lewat Baileys, lalu simpan ke file sementara.
 * @returns {Promise<string>} path file sementara
 */
async function unduhDariProto(media, jenis) {
  const media2 = media?.quoted || {};
  const field = Object.keys(media2).find((k) => k.endsWith('Message'));
  if (!field) throw new Error(`File ${jenis} tidak ditemukan setelah diunduh.`);
  const stream = await downloadContentFromMessage(media2[field], field.replace('Message', ''));
  const chunk = [];
  for await (const c of stream) chunk.push(c);
  const buffer = Buffer.concat(chunk);
  if (!buffer.length) throw new Error(`File ${jenis} tidak ditemukan setelah diunduh.`);
  const file = fileSementara('bin');
  fs.writeFileSync(file, buffer);
  return file;
}

/** Unggah stiker + audio ke CDN WhatsApp, lalu kirim sebagai sound sticker. */
async function kirimStikerAudio(sock, remoteJid, message, stiker, audio, langkah) {
  const upAudio = await langkah('upload audio', 60_000, () =>
    sock.waUploadToServer(fs.readFileSync(audio.file), { type: 'audio', mimetype: MIME_AUDIO }),
  );

  await kirimStikerSuara(sock, remoteJid, {
    webpBuffer: stiker.webpBuffer,
    isAnimated: stiker.isAnimated,
    audioMessage: {
      ...fieldMedia(upAudio, MIME_AUDIO),
      seconds: audio.seconds,
      ptt: false,
      ...(upAudio.streamingSidecar ? { streamingSidecar: upAudio.streamingSidecar } : {}),
    },
    quoted: message,
    langkah,
  });
}

/**
 * Urutan cara pakai = dari yang PALING MUDAH dipahami user:
 * satu pesan tanpa audio -> satu pesan video -> dua kali balas -> kasus
 * khusus -> balas sambil melampirkan media (paling jarang diketahui user).
 */
function teksBantuan(cmd) {
  const menit = MASA_PILIHAN / 60_000;
  return (
    `🔊 *Cara pakai ${cmd}* — stiker bersuara (maks ${DURASI_MAKS} detik)\n\n` +
    `*1. Gambar/stiker + teks*\n` +
    `Kirim gambar dengan caption *${cmd} halo semua*\n` +
    `atau balas gambar/stiker dengan *${cmd} halo semua*\n` +
    `_Teksnya dibacakan seperti .vn_\n\n` +
    `*2. Video bersuara*\n` +
    `Kirim video dengan caption *${cmd}*, atau balas video dengan *${cmd}*\n` +
    `_Video tanpa suara/GIF: tambahkan teks, mis. *${cmd} halo*_\n\n` +
    `*3. Gabungkan stiker/gambar/video + VN yang sudah ada*\n` +
    `Balas stiker/gambar/videonya dengan *${cmd}*, lalu balas VN/audionya dengan *${cmd}*\n` +
    `_Urutan bebas, maks ${menit} menit. Batal: *${cmd} batal*_\n\n` +
    `*4. VN/audio/file mp3 yang membalas stiker/gambar/video*\n` +
    `Cukup balas VN/audio itu dengan *${cmd}*\n\n` +
    `*5. Kirim gambar/video sambil membalas VN*\n` +
    `Geser/balas VN-nya, lampirkan gambar/video, beri caption *${cmd}*`
  );
}

/**
 * Media yang DIBALAS pesan ini: jenisnya ('image' | 'audio' | 'sticker' |
 * ...) + proto-nya (untuk disimpan sebagai pilihan dua langkah).
 *
 * Tidak memakai `messageInfo.isQuoted`: isQuotedMessage() di lib/utils.js
 * hanya membaca balasan dari `extendedTextMessage` (pesan teks). Gambar
 * ber-caption yang membalas VN menyimpan balasannya di
 * `imageMessage.contextInfo`, jadi di sana `isQuoted` selalu false.
 * getContextInfo membaca contextInfo dari jenis pesan apa pun — fungsi ini
 * juga dipakai lib/stickerAudioCache.js, jadi hasilnya konsisten.
 */
function infoDibalas(message) {
  const ctx = getContextInfo(message);
  const quoted = ctx?.quotedMessage;
  if (!quoted) return { jenis: null, media: null };
  return {
    // mediaSa: mp3 yang dikirim sebagai file (documentMessage) = 'audio'.
    jenis: mediaSa(quoted)?.mediaType ?? null,
    media: { quoted, stanzaId: ctx.stanzaId, participant: ctx.participant },
  };
}

const JENIS_VISUAL = new Set(['image', 'sticker', 'video']);
const namaVisual = (jenis) =>
  jenis === 'sticker' ? 'stiker' : jenis === 'video' ? 'video' : 'gambar';

/**
 * Tentukan dari mana visual & suara diambil.
 *
 * Bentuk hasil:
 *  - { rencana: { visual: { asal, jenis, media? }, suara: { asal, media? } } }
 *      asal visual: 'langsung' | 'dibalas' | 'proto'
 *      asal suara : 'tts' | 'dibalas' | 'proto' | 'visual' (suara video itu)
 *  - { balas: '...' }  -> cukup kirim teks ini (pilihan disimpan / bantuan)
 */
function susunRencana({ type, dibalas, teks, remoteJid, user, cmd, message }) {
  const tersimpan = ambilPilihan(remoteJid, user);

  // Gambar/video ber-caption .sa (media ada di pesan ini).
  if (type === 'image' || type === 'video') {
    const visual = { asal: 'langsung', jenis: type };
    if (dibalas.jenis === 'audio') return { rencana: { visual, suara: { asal: 'dibalas' } } };
    if (teks) return { rencana: { visual, suara: { asal: 'tts' } } };
    if (tersimpan?.jenis === 'audio') {
      return { rencana: { visual, suara: { asal: 'proto', media: tersimpan } } };
    }
    if (type === 'video') return { rencana: { visual, suara: { asal: 'visual' } } };
    // Gambar ber-caption `.sa` saja: tidak ada sumber suara.
    return {
      balas:
        `⚠️ Gambarnya belum ada suara. Tulis teks setelah *${cmd}*, mis. *${cmd} halo semua*, ` +
        `atau kirim gambar ini sambil membalas VN.\n\n` +
        teksBantuan(cmd),
    };
  }

  // Membalas stiker/gambar/video.
  if (JENIS_VISUAL.has(dibalas.jenis)) {
    const visual = { asal: 'dibalas', jenis: dibalas.jenis };
    if (teks) return { rencana: { visual, suara: { asal: 'tts' } } };
    if (tersimpan?.jenis === 'audio') {
      return { rencana: { visual, suara: { asal: 'proto', media: tersimpan } } };
    }
    // Video punya suara sendiri -> langsung jadi, tidak perlu memilih VN.
    if (dibalas.jenis === 'video') return { rencana: { visual, suara: { asal: 'visual' } } };
    simpanPilihan(remoteJid, user, 'visual', { ...dibalas.media, jenisMedia: dibalas.jenis });
    return {
      balas:
        `✅ ${namaVisual(dibalas.jenis)} dipilih.\n\n` +
        `Sekarang *balas VN/audio* yang mau dipakai dengan *${cmd}* ` +
        `(dalam ${MASA_PILIHAN / 60_000} menit).\n` +
        `_Atau balas ${namaVisual(dibalas.jenis)} ini dengan *${cmd} teks* untuk suara dari teks._`,
    };
  }

  // Membalas VN/audio.
  if (dibalas.jenis === 'audio') {
    const suara = { asal: 'dibalas' };
    if (tersimpan?.jenis === 'visual') {
      return {
        rencana: {
          visual: { asal: 'proto', jenis: tersimpan.jenisMedia, media: tersimpan },
          suara,
        },
      };
    }
    // VN ini sendiri membalas stiker/gambar (skenario 4).
    const bersarang = visualBersarang(message, remoteJid);
    if (bersarang) {
      return {
        rencana: { visual: { asal: 'proto', jenis: bersarang.jenis, media: bersarang }, suara },
      };
    }
    simpanPilihan(remoteJid, user, 'audio', dibalas.media);
    return {
      balas:
        `✅ VN/audio dipilih.\n\n` +
        `Sekarang *balas stiker/gambar/video* yang mau dipakai dengan *${cmd}* ` +
        `(dalam ${MASA_PILIHAN / 60_000} menit).\n` +
        `_Kalau VN/audio ini membalas stiker tapi stikernya tidak terbaca ` +
        `(mis. dikirim saat bot belum aktif), balas stiker itu dengan *${cmd}*._`,
    };
  }

  const catatan = tersimpan
    ? `📌 Kamu sudah memilih ${tersimpan.jenis === 'audio' ? 'VN/audio' : namaVisual(tersimpan.jenisMedia)}. ` +
      `Tinggal balas ${tersimpan.jenis === 'audio' ? 'stiker/gambar' : 'VN/audio'}-nya dengan *${cmd}*.\n\n`
    : '';
  return { balas: catatan + teksBantuan(cmd) };
}

/**
 * Pencatat langkah untuk SATU proses .sa. Tiap langkah diberi batas waktu
 * dan durasinya dicatat, lalu di akhir dicetak SATU baris ringkasan ke
 * console (dulu 2 baris per langkah + baris rencana + baris gagal).
 *
 * Batas waktu tetap perlu: tanpa itu satu langkah yang menggantung (mis.
 * koneksi TTS yang tertahan di panel) membuat pengguna hanya melihat ⏰
 * selamanya. Dengan batas waktu, pengguna mendapat pesan "macet di langkah
 * X" dan ringkasan console menyebut langkah mana yang gagal.
 */
function buatJejak() {
  const mulai = Date.now();
  const selesai = [];
  let gagalDi = null;

  async function langkah(nama, ms, fn) {
    const t0 = Date.now();
    let timer;
    try {
      // ms = null -> tanpa batas waktu. Dipakai untuk pengiriman pesan: kalau
      // dibatalkan timeout, pesannya tetap bisa sampai belakangan.
      const hasil =
        ms == null
          ? await fn()
          : await Promise.race([
              fn(),
              new Promise((_, reject) => {
                timer = setTimeout(
                  () => reject(new Error(`Macet di langkah "${nama}" (lebih dari ${ms / 1000} detik).`)),
                  ms,
                );
              }),
            ]);
      selesai.push(`${nama} ${Date.now() - t0}ms`);
      return hasil;
    } catch (error) {
      gagalDi ??= nama;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  const detik = () => ((Date.now() - mulai) / 1000).toFixed(1);

  return {
    langkah,
    berhasil(ringkas) {
      console.log(`[SA] ✔ ${ringkas} | ${detik()} dtk (${selesai.join(' · ')})`);
    },
    gagal(ringkas, error) {
      const di = gagalDi ? ` di langkah "${gagalDi}"` : '';
      console.log(`[SA] ✘ ${ringkas} | gagal${di} setelah ${detik()} dtk: ${error?.message || error}`);
    },
  };
}

/**
 * Teks -> suara, SAMA dengan .vn: /api/tts (API Autoresbot) dulu, kalau gagal
 * baru Google TTS. Disimpan sementara agar bisa diproses ffmpeg (formatnya
 * dideteksi ffmpeg sendiri, jadi ekstensi file tidak berpengaruh).
 */
async function suaraDariTeks(teks) {
  const buffer = await getVoiceBuffer(teks);
  if (!buffer?.length) throw new Error('Gagal mengubah teks menjadi suara. Coba lagi nanti.');
  const file = fileSementara('mp3');
  fs.writeFileSync(file, buffer);
  return file;
}

/* ------------------------------------------------------------------------
 * Limit. `.sa` TIDAK memakai `limitDeduction` (yang dipotong autoresbot.js
 * SEBELUM handle jalan, untuk setiap panggilan): dengan itu cara dua langkah
 * makan 2 limit untuk 1 stiker, dan `.sa batal` / pesan bantuan / "✅ dipilih"
 * ikut makan limit. Di sini limit dicek sebelum memproses dan baru dipotong
 * setelah stiker BERHASIL terkirim. Aturannya meniru autoresbot.js: premium,
 * owner, dan grup premium tidak dipotong.
 * ---------------------------------------------------------------------- */

const BIAYA_LIMIT = 1;

/**
 * Data user yang perlu dipotong energinya, atau null bila bebas.
 * GX-ID memakai `energi` sebagai "limit" (db.updateEnergi). Owner & premium
 * dengan energi -1 tidak pernah dipotong (ditangani db.updateEnergi).
 */
function userBerlimit(senderLid) {
  if (!senderLid || isOwner(senderLid) || !config.energi?.enabled) return null;
  const db = getDatabase();
  const data = db.getUser(senderLid);
  if (!data) return null;
  if (data.energi === -1) return null; // tak terbatas
  return data;
}

async function potongLimit(senderLid) {
  try {
    if (!userBerlimit(senderLid)) return;
    getDatabase().updateEnergi(senderLid, -BIAYA_LIMIT);
  } catch (error) {
    console.error(`[SA] Gagal memotong energi: ${error?.message || error}`);
  }
}

async function handle(m, { sock }) {
  // Di GX-ID `m.type` berbentuk "imageMessage"/"audioMessage"; di sini dipakai
  // jenis pendek ('image'|'video'|'sticker'|'audio') seperti RESBOT.
  const shortType = m.isImage
    ? 'image'
    : m.isVideo
      ? 'video'
      : m.isSticker
        ? 'sticker'
        : m.isAudio
          ? 'audio'
          : m.isDocument
            ? 'document'
            : null;
  const remoteJid = m.chat;
  const message = m.raw;
  const prefix = m.prefix || config.command?.prefix || '.';
  const command = m.command;
  const senderLid = m.sender;
  const cmd = prefix + command;
  const teks = String(m.text || '').trim();
  const user = senderLid;

  if (teks.toLowerCase() === 'batal') {
    const ada = ambilPilihan(remoteJid, user);
    hapusPilihan(remoteJid, user);
    return sock.sendMessage(
      remoteJid,
      { text: ada ? '✅ Pilihan .sa dibatalkan.' : 'Tidak ada pilihan .sa yang tersimpan.' },
      { quoted: message },
    );
  }

  if (typeof sock.waUploadToServer !== 'function') {
    return sock.sendMessage(
      remoteJid,
      { text: '❌ Fitur ini butuh koneksi yang mendukung upload media manual.' },
      { quoted: message },
    );
  }

  const hasil = susunRencana({
    type: shortType,
    dibalas: infoDibalas(message),
    teks,
    remoteJid,
    user,
    cmd,
    message,
  });
  if (hasil.balas) {
    return sock.sendMessage(remoteJid, { text: hasil.balas }, { quoted: message });
  }
  const mode = hasil.rencana;

  // Cek limit SEBELUM mengunduh/mengunggah apa pun (dipotongnya nanti, setelah
  // stiker berhasil terkirim).
  try {
    const data = userBerlimit(senderLid);
    if (data && data.energi < BIAYA_LIMIT) {
      return sock.sendMessage(
        remoteJid,
        {
          text:
            `⚠️ *Energi tidak cukup.*\n\n` +
            `Sisa energi: ${data.energi}\nButuh: ${BIAYA_LIMIT}\n` +
            `_Energi dipakai untuk membuat stiker suara._`,
        },
        { quoted: message },
      );
    }
  } catch (error) {
    console.error(`[SA] Gagal mengecek energi: ${error?.message || error}`);
  }

  const sampah = [];
  const jejak = buatJejak();
  const { langkah } = jejak;
  const namaSuara = { tts: 'teks/TTS', visual: 'suara video', dibalas: 'VN/audio', proto: 'VN/audio' };
  const ringkas =
    `${namaVisual(mode.visual.jenis)} (${mode.visual.asal}) + ` +
    `${namaSuara[mode.suara.asal] ?? mode.suara.asal} (${mode.suara.asal})`;

  try {
    await sock.sendMessage(remoteJid, { react: { text: '⏰', key: message.key } });

    let audio;
    let stiker;

    // asal: 'langsung' (media di pesan ini) | 'dibalas' (media yang dibalas)
    //       | 'proto' (proto tersimpan: stiker bersarang / pilihan dua langkah)
    // Semua mengembalikan path file sementara.
    const unduh = async (asal, media, jenis) => {
      if (asal === 'proto') return unduhDariProto(media, jenis);
      const source = asal === 'dibalas' ? m.quoted : m;
      const buffer = source ? await downloadMedia(source) : null;
      if (!buffer?.length) throw new Error(`File ${jenis} tidak ditemukan setelah diunduh.`);
      const file = fileSementara('bin');
      fs.writeFileSync(file, buffer);
      return file;
    };

    const jenisVisual = namaVisual(mode.visual.jenis);
    const visualPath = await langkah(`unduh ${jenisVisual}`, 60_000, () =>
      unduh(mode.visual.asal, mode.visual.media, jenisVisual),
    );
    sampah.push(visualPath);

    let audioPath;
    if (mode.suara.asal === 'visual') {
      audioPath = visualPath; // suara video itu sendiri
    } else if (mode.suara.asal === 'tts') {
      audioPath = await langkah('suara TTS', 40_000, () => suaraDariTeks(teks));
      sampah.push(audioPath);
    } else {
      audioPath = await langkah('unduh VN/audio', 60_000, () =>
        unduh(mode.suara.asal, mode.suara.media, 'audio'),
      );
      sampah.push(audioPath);
    }

    // Suara dulu: kalau videonya bisu, tidak perlu repot membuat stiker.
    audio = await langkah('ubah audio ke opus', 60_000, () =>
      ekstrakAudio(
        audioPath,
        mode.suara.asal === 'tts' ? 'Suara TTS' : mode.suara.asal === 'visual' ? 'Video ini' : 'Audio itu',
      ),
    ).catch((error) => {
      if (mode.suara.asal === 'visual' && /tidak punya suara/.test(error?.message || '')) {
        throw new Error(
          `Video ini tidak punya suara.\nTambahkan teks, mis. *${cmd} halo semua*, ` +
            `atau kirim videonya sambil membalas VN.`,
        );
      }
      throw error;
    });
    sampah.push(audio.file);

    stiker = await langkah(
      `buat stiker dari ${jenisVisual}`,
      mode.visual.jenis === 'video' ? 90_000 : 60_000,
      () =>
        mode.visual.jenis === 'video'
          ? stikerDariVideo(visualPath)
          : mode.visual.jenis === 'sticker'
            ? stikerDariStiker(visualPath, audio.seconds)
            : stikerDariGambar(visualPath, audio.seconds),
    );
    await kirimStikerAudio(sock, remoteJid, message, stiker, audio, langkah);
    jejak.berhasil(ringkas);
    // Pilihan dua langkah baru dihapus setelah BERHASIL: kalau unduh/kirim
    // gagal, user cukup mengulang langkah kedua tanpa memilih ulang.
    hapusPilihan(remoteJid, user);
    await potongLimit(senderLid);
  } catch (error) {
    jejak.gagal(ringkas, error);
    await sock.sendMessage(
      remoteJid,
      { text: `❌ Gagal membuat sticker audio.\n\n${error?.message || error}` },
      { quoted: message },
    );
    try {
      await sock.sendMessage(remoteJid, { react: { text: '❌', key: message.key } });
    } catch {
      // reaksi hanya kosmetik
    }
  } finally {
    hapus(...sampah);
  }
}

const pluginConfig = {
  name: 'sa',
  alias: ['stickeraudio', 'stikeraudio'],
  category: 'sticker',
  description: 'Membuat stiker berbunyi (sound sticker) dari gambar/stiker/video + suara VN atau teks (TTS)',
  usage: '.sa <teks> (balas/kirim gambar) atau .sa (balas VN/audio)',
  example: '.sa halo semua',
  isOwner: false,
  isPremium: false,
  isGroup: false,
  isPrivate: false,
  cooldown: 3,
  // .sa mengurus limitnya sendiri (cek sebelum proses, potong setelah berhasil),
  // jadi baris limit bawaan tidak boleh dipotong di depan. Lihat potongLimit.
  limit: 0,
  // `sa` tanpa argumen valid (mode dua langkah), jadi jangan tampilkan usage card.
  runsBare: true,
  isEnabled: true,
};

export { pluginConfig as config, handle as handler };
