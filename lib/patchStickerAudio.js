/**
 * Tambal protobuf StickerMessage Baileys agar mendukung `audioMessage`
 * (fitur "sound sticker" WhatsApp).
 *
 * Kenapa perlu: proto StickerMessage yang dibundel Baileys 7.0.0-rc14 (dan
 * upstream master) TIDAK punya field `audioMessage`, jadi audio yang kita
 * sisipkan dibuang saat encode -> stiker terkirim tanpa suara.
 *
 * Nomor field diambil dari schema proto zapo-js 1.12.1 (yang dipakai bot lain
 * dan terbukti membuat sound sticker): `StickerMessage.audioMessage` =
 * field **26**, wire type 2, tipe `Message.AudioMessage`. Tag protobuf =
 * (26 << 3) | 2 = 210.
 *
 * Patch dilakukan sekali (idempoten) dengan membungkus encode/decode statis
 * proto Baileys, jadi `relayMessage`/`sendMessage` biasa otomatis ikut.
 */

import { proto } from "@whiskeysockets/baileys";

const FIELD_TAG = 210; // StickerMessage.audioMessage: field 26, wire type 2

let patched = false;

export function patchStickerAudio() {
  if (patched) return;
  const SM = proto?.Message?.StickerMessage;
  const Audio = proto?.Message?.AudioMessage;
  if (!SM?.encode || !Audio?.encode) return;

  const encodeAsli = SM.encode;
  SM.encode = function encode(m, w) {
    // Encode field-field StickerMessage biasa dulu.
    const writer = encodeAsli(m, w);
    // Sisipkan audioMessage (field 26) di akhir, sebelum parent memanggil
    // ldelim(). Audio di-encode sebagai nested Message.AudioMessage.
    // Cukup untuk MENGIRIM; stiker suara yang masuk tetap terbaca audionya
    // lewat quotedMessage proto mentah atau cache (decode tak perlu diubah).
    if (m && m.audioMessage != null && Object.hasOwnProperty.call(m, "audioMessage")) {
      Audio.encode(m.audioMessage, writer.uint32(FIELD_TAG).fork()).ldelim();
    }
    return writer;
  };

  patched = true;
}
