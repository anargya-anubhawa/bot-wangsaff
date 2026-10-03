import fs from "fs";
import path from "path";
import config from "../../config.js";
import { getDatabase } from "../../src/lib/GX-database.js";
import { serialize } from "../../src/lib/GX-serialize.js";
import te from "../../src/lib/GX-error.js";

/**
 * /quotely — Quotly-style quote sticker (GX-ID)
 *
 * Mengubah pesan yang direply menjadi sticker kartu kutipan.
 *   /quotely     → 1 bubble  (pesan yang direply)
 *   /quotely 2   → pesan direply + 1 pesan berikutnya
 *   /quotely 3   → pesan direply + 2 pesan berikutnya
 *   /quotely 4   → pesan direply + 3 pesan berikutnya
 *
 * Pesan berikutnya diambil dari message store GX-ID (sock.store.messages)
 * yang sudah tersedia — tidak membuat store/history baru.
 *
 * Renderer memakai @napi-rs/canvas (dependency GX-ID yang sudah ada).
 * Konversi ke sticker memakai sock.sendImageAsSticker() (GX-socket).
 *
 * Catatan: command utama dinamai `quotely` (bukan `quote`) karena `quote`
 * sudah dipakai sebagai alias plugin lain (katakata) di GX-ID.
 */

const MAX_BUBBLES = 4;
const DEFAULT_BUBBLES = 1;
const STICKER_SIZE = 512;
const AVATAR_TIMEOUT = 6000;

const pluginConfig = {
  name: "quotely",
  alias: ["qsticker", "quotebubble", "bubblequote", "quotechat"],
  category: "sticker",
  description: "Ubah pesan yang direply menjadi sticker quote bergaya Quotly. N = 1-4 bubble.",
  usage: ".quotely [N]",
  example: ".quotely 3",
  isOwner: false,
  isPremium: false,
  isGroup: false,
  isPrivate: false,
  isAdmin: false,
  isBotAdmin: false,
  cooldown: 5,
  energi: 0,
  isEnabled: true,
};

/* ═══════════════════════════════════════════════════════════════════════
 *  TEXT / MESSAGE HELPERS
 * ═══════════════════════════════════════════════════════════════════════ */

/** Representasi teks dari sebuah pesan terserialisasi. */
function textForSerialized(s) {
  if (!s) return "";
  const body = (s.body || "").trim();
  if (body) return body;

  const t = s.type || "";
  if (t === "imageMessage") return s.message?.imageMessage?.caption || "🖼️ Image";
  if (t === "videoMessage")
    return s.message?.videoMessage?.caption || "🎬 Video";
  if (t === "audioMessage") return "🎵 Audio";
  if (t === "stickerMessage") return "🩹 Sticker";
  if (t === "documentMessage")
    return s.message?.documentMessage?.fileName
      ? `📄 ${s.message.documentMessage.fileName}`
      : "📄 Document";
  if (t === "contactMessage" || t === "contactsArrayMessage")
    return "👤 Contact";
  if (t === "locationMessage" || t === "liveLocationMessage")
    return "📍 Location";
  if (t === "pollCreationMessage") return "📊 Poll";
  return body || "";
}

/** Ambil nomor dari JID. */
function numberFromJid(jid) {
  return String(jid || "").split("@")[0].split(":")[0];
}

/** Resolve nama pengirim (pushName → contacts DB → nomor). */
function resolveName(jid, db, fallback = "") {
  if (fallback && fallback !== "~ User" && fallback !== "Unknown") return fallback;
  if (!jid) return "User";
  try {
    const contacts = db?.setting("contacts") || {};
    if (contacts[jid]?.name) return contacts[jid].name;
  } catch {}
  const num = numberFromJid(jid);
  return num ? `+${num}` : "User";
}

/** Cari Map pesan untuk chat (toleran terhadap perbedaan LID/JID). */
function findChatMap(sock, chatId, m) {
  const messages = sock?.store?.messages;
  if (!messages || typeof messages.get !== "function") return null;

  const direct = messages.get(chatId);
  if (direct) return direct;

  const candidates = new Set(
    [chatId, m?.key?.remoteJid, m?.chat].filter(Boolean).map((v) => String(v)),
  );
  const norm = (v) => String(v || "").split("@")[0];

  for (const [jid, map] of messages) {
    if (candidates.has(String(jid))) return map;
  }
  for (const [jid, map] of messages) {
    for (const c of candidates) {
      if (norm(jid) && norm(jid) === norm(c)) return map;
    }
  }
  return null;
}

/**
 * Kumpulkan bubble: mulai dari pesan yang direply, lalu N-1 pesan berikutnya
 * sesuai urutan chat asli (insertion order store).
 */
async function collectBubbles(m, sock, db, n) {
  const bubbles = [];
  const quotedId = m.quoted?.id || m.quoted?.key?.id || "";
  const chatMap = findChatMap(sock, m.chat, m);
  const skipId = m.id || m.key?.id || ""; // jangan masukkan pesan command sendiri

  if (chatMap && quotedId) {
    const ids = [...chatMap.keys()];
    const idx = ids.indexOf(quotedId);
    if (idx !== -1) {
      // Iterasi maju mulai dari pesan yang direply, ambil sampai n bubble.
      for (let i = idx; i < ids.length && bubbles.length < n; i++) {
        const id = ids[i];
        if (id === skipId) continue; // lewati pesan /quotely itu sendiri
        let s;
        try {
          s = await serialize(sock, chatMap.get(id));
        } catch {
          continue; // lewati pesan yang gagal diserialisasi
        }
        if (!s) continue;
        const text = textForSerialized(s);
        // Lewati pesan tanpa teks (protocol/reaction/dll), kecuali bubble pertama
        if (!text && bubbles.length > 0) continue;
        const jid = s.sender || s.key?.participant || "";
        bubbles.push({
          name: resolveName(jid, db, s.pushName),
          text,
          jid,
        });
      }
    }
  }

  // Fallback: minimal pakai pesan yang direply
  if (bubbles.length === 0 && m.quoted) {
    bubbles.push({
      name: resolveName(m.quoted.sender, db, m.quoted.pushName),
      text: textForSerialized(m.quoted),
      jid: m.quoted.sender || "",
    });
  }

  return bubbles.slice(0, n);
}

/* ═══════════════════════════════════════════════════════════════════════
 *  RENDERER (Quotly-style card)
 * ═══════════════════════════════════════════════════════════════════════ */

let _canvasMod = null;
async function getCanvas() {
  if (!_canvasMod) _canvasMod = await import("@napi-rs/canvas");
  return _canvasMod;
}

let _fontReady = false;
function ensureFont(GlobalFonts) {
  if (_fontReady) return;
  _fontReady = true;
  try {
    const candidates = [
      path.join(process.cwd(), "assets", "fonts", "arialnarrow.ttf"),
      path.join(process.cwd(), "assets", "GX-font.ttf"),
    ];
    for (const f of candidates) {
      if (fs.existsSync(f)) {
        GlobalFonts.registerFromPath(f, "QuoteFont");
        break;
      }
    }
  } catch {}
}

/**
 * Font stack untuk renderer. Sertakan beberapa font emoji umum agar emoji
 * tampil berwarna bila tersedia (Windows/Linux), dan tetap aman bila tidak ada.
 */
const FONT_STACK =
  'QuoteFont, "Segoe UI Emoji", "Noto Color Emoji", "Apple Color Emoji", ' +
  '"Twemoji Mozilla", "EmojiOne Color", "Android Emoji", sans-serif';

const fontOf = (size, bold = false) =>
  `${bold ? "bold " : ""}${size}px ${FONT_STACK}`;

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Wrap teks ke beberapa baris sesuai lebar maksimum. */
function wrapLines(ctx, text, maxWidth) {
  const out = [];
  const paragraphs = String(text ?? "").replace(/\r/g, "").split("\n");
  for (const para of paragraphs) {
    if (para === "") {
      out.push("");
      continue;
    }
    const words = para.split(" ");
    let line = "";
    for (let word of words) {
      // Pecah kata yang lebih panjang dari lebar kartu (mis. URL/teks tanpa spasi)
      if (ctx.measureText(word).width > maxWidth) {
        if (line) {
          out.push(line);
          line = "";
        }
        let chunk = "";
        for (const ch of word) {
          if (chunk && ctx.measureText(chunk + ch).width > maxWidth) {
            out.push(chunk);
            chunk = ch;
          } else {
            chunk += ch;
          }
        }
        line = chunk;
        continue;
      }
      const test = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(test).width > maxWidth) {
        out.push(line);
        line = word;
      } else {
        line = test;
      }
    }
    out.push(line);
  }
  return out;
}

async function fetchAvatar(loadImage, sock, jid) {
  if (!jid) return null;
  try {
    const url = await Promise.race([
      sock.profilePictureUrl(jid, "image"),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), AVATAR_TIMEOUT)),
    ]);
    if (!url) return null;
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return await loadImage(buf);
  } catch {
    return null;
  }
}

function bubbleSizes(n) {
  if (n <= 1) return { name: 22, text: 26, lineH: 34, avatar: 40 };
  if (n === 2) return { name: 20, text: 23, lineH: 30, avatar: 36 };
  if (n === 3) return { name: 18, text: 21, lineH: 28, avatar: 32 };
  return { name: 16, text: 19, lineH: 25, avatar: 30 };
}

/**
 * Render kartu quote menjadi buffer PNG.
 * @param {Array<{name:string,text:string,jid:string}>} bubbles
 * @param {object} sock
 * @returns {Promise<Buffer>}
 */
async function renderQuoteCard(bubbles, sock) {
  const { createCanvas, loadImage, GlobalFonts } = await getCanvas();
  ensureFont(GlobalFonts);

  const n = bubbles.length;
  const W = STICKER_SIZE;
  const pad = 20;
  const gap = 12;
  const innerPad = 16;
  const maxTextWidth = W - pad * 2 - innerPad * 2;
  const MAX_H = STICKER_SIZE; // jaga agar tidak perlu di-downscale oleh sendImageAsSticker

  // Pre-fetch avatar (best effort, paralel)
  const avatars = await Promise.all(
    bubbles.map((b) => fetchAvatar(loadImage, sock, b.jid)),
  );

  const measure = createCanvas(10, 10).getContext("2d");

  // Hitung konfigurasi yang DIJAMIN muat dalam MAX_H:
  // availableTextH = MAX_H - padding - gaps - tinggi header semua bubble
  // lalu tentukan batas baris per bubble dari sisa ruang tsb.
  const tiers = [
    { factor: 1.0 },
    { factor: 0.9 },
    { factor: 0.8 },
    { factor: 0.72 },
    { factor: 0.64 },
    { factor: 0.58 },
  ];

  let layout = null;
  let H = MAX_H;

  for (const tier of tiers) {
    const base = bubbleSizes(n);
    const sz = {
      name: Math.max(12, Math.round(base.name * tier.factor)),
      text: Math.max(13, Math.round(base.text * tier.factor)),
      lineH: Math.max(16, Math.round(base.lineH * tier.factor)),
      avatar: Math.max(24, Math.round(base.avatar * tier.factor)),
    };
    const headerH = Math.max(sz.avatar, sz.name + 8);
    const fixedPerBubble = innerPad * 2 + headerH + 8;

    const availableTextH =
      MAX_H - pad * 2 - gap * (n - 1) - fixedPerBubble * n;
    const maxLinesPerBubble = Math.floor(availableTextH / (n * sz.lineH));

    if (maxLinesPerBubble < 1) continue; // font masih terlalu besar, coba tier berikutnya

    measure.font = fontOf(sz.text);
    const lineCap = Math.min(maxLinesPerBubble, 14);

    const items = bubbles.map((b, i) => {
      const lines = wrapLines(measure, b.text || "", maxTextWidth);
      const capped =
        lines.length > lineCap ? lines.slice(0, lineCap) : lines;
      if (lines.length > lineCap)
        capped[lineCap - 1] = `${capped[lineCap - 1]}…`;
      const textH = capped.length * sz.lineH;
      const bubbleH = fixedPerBubble + textH;
      return { bubble: b, lines: capped, bubbleH, avatar: avatars[i], sz };
    });

    const totalH =
      pad + items.reduce((a, l) => a + l.bubbleH, 0) + gap * (n - 1) + pad;

    layout = items;
    H = Math.min(MAX_H, Math.max(240, Math.round(totalH)));
    break;
  }

  if (!layout) {
    // Fallback ekstrem (seharusnya tidak terjadi): font minimum
    const sz = { name: 12, text: 13, lineH: 16, avatar: 24 };
    const headerH = Math.max(sz.avatar, sz.name + 8);
    const fixedPerBubble = innerPad * 2 + headerH + 8;
    measure.font = fontOf(sz.text);
    layout = bubbles.map((b, i) => {
      const capped = wrapLines(measure, b.text || "", maxTextWidth).slice(0, 2);
      return {
        bubble: b,
        lines: capped,
        bubbleH: fixedPerBubble + capped.length * sz.lineH,
        avatar: avatars[i],
        sz,
      };
    });
    H = MAX_H;
  }

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  // Background gradient
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, "#1b1b2f");
  bg.addColorStop(0.5, "#232338");
  bg.addColorStop(1, "#15151f");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // Decorative glow
  const glow = ctx.createRadialGradient(W, 0, 0, W, 0, W);
  glow.addColorStop(0, "rgba(126, 200, 255, 0.10)");
  glow.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  let y = pad;
  for (const item of layout) {
    const x = pad;
    const w = W - pad * 2;
    const h = item.bubbleH;
    const sz = item.sz;

    // Bubble card
    roundRect(ctx, x, y, w, h, 18);
    ctx.fillStyle = "rgba(255, 255, 255, 0.06)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.10)";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Accent bar
    roundRect(ctx, x, y + 14, 4, h - 28, 2);
    ctx.fillStyle = "#7ec8ff";
    ctx.fill();

    // Avatar
    const avX = x + innerPad + sz.avatar / 2;
    const avY = y + innerPad + sz.avatar / 2;
    ctx.save();
    ctx.beginPath();
    ctx.arc(avX, avY, sz.avatar / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    if (item.avatar) {
      ctx.drawImage(
        item.avatar,
        avX - sz.avatar / 2,
        avY - sz.avatar / 2,
        sz.avatar,
        sz.avatar,
      );
    } else {
      ctx.fillStyle = "#3a4a63";
      ctx.fillRect(
        avX - sz.avatar / 2,
        avY - sz.avatar / 2,
        sz.avatar,
        sz.avatar,
      );
    }
    ctx.restore();
    // Avatar ring
    ctx.beginPath();
    ctx.arc(avX, avY, sz.avatar / 2, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(126, 200, 255, 0.6)";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Sender name
    const nameX = x + innerPad + sz.avatar + 10;
    ctx.fillStyle = "#7ec8ff";
    ctx.font = fontOf(sz.name, true);
    ctx.textBaseline = "middle";
    const nameText =
      item.bubble.name.length > 26
        ? `${item.bubble.name.slice(0, 25)}…`
        : item.bubble.name;
    ctx.fillText(nameText, nameX, avY);

    // Message text
    ctx.textBaseline = "top";
    ctx.fillStyle = "#eef1f7";
    ctx.font = fontOf(sz.text);
    let ty = y + innerPad + Math.max(sz.avatar, sz.name + 8) + 8;
    for (const line of item.lines) {
      ctx.fillText(line, x + innerPad, ty);
      ty += sz.lineH;
    }

    y += h + gap;
  }

  return canvas.toBuffer("image/png");
}

/* ═══════════════════════════════════════════════════════════════════════
 *  HANDLER
 * ═══════════════════════════════════════════════════════════════════════ */

const MSG_INVALID = (cmd) =>
  `❌ *Format tidak valid.*\n\n` +
  `Gunakan:\n` +
  `${cmd}\n${cmd} 2\n${cmd} 3\n${cmd} 4\n\n` +
  `Maksimal 4 pesan.`;

const MSG_NO_REPLY = (cmd) =>
  `❌ *Silakan reply pesan teks yang ingin dijadikan quote.*\n\n` +
  `Contoh:\n\nReply sebuah pesan lalu ketik:\n${cmd}`;

async function handler(m, { sock, db }) {
  try {
    if (!db) db = getDatabase();

    const cmd = `${m.prefix || "."}${m.command || "quotely"}`;

    // ── Parse argumen N ──────────────────────────────────────────────
    const rawArg = (m.text || "").trim();
    let n = DEFAULT_BUBBLES;
    if (rawArg) {
      const valid = new RegExp(`^[1-${MAX_BUBBLES}]$`);
      if (!valid.test(rawArg)) {
        if (m.react) await m.react("❌");
        return m.reply(MSG_INVALID(cmd));
      }
      n = parseInt(rawArg, 10);
    }

    // ── Wajib reply ──────────────────────────────────────────────────
    if (!m.quoted || (!m.quoted.id && !m.quoted.key?.id)) {
      if (m.react) await m.react("❌");
      return m.reply(MSG_NO_REPLY(cmd));
    }

    if (m.react) await m.react("🕕");

    // ── Kumpulkan bubble ─────────────────────────────────────────────
    const bubbles = await collectBubbles(m, sock, db, n);
    if (!bubbles.length) {
      if (m.react) await m.react("❌");
      return m.reply(MSG_NO_REPLY(cmd));
    }

    // ── Render ───────────────────────────────────────────────────────
    const png = await renderQuoteCard(bubbles, sock);

    // ── Kirim sebagai sticker (EXIF dari config GX-ID) ───────────────
    await sock.sendImageAsSticker(m.chat, png, m, {
      packname: config.sticker?.packname,
      author: config.sticker?.author,
    });

    if (m.react) await m.react("✅");

    // Info jika bubble kurang dari yang diminta
    if (bubbles.length < n) {
      await m.reply(
        `ℹ️ Hanya *${bubbles.length}* pesan yang tersedia setelah pesan yang dipilih.`,
      );
    }
  } catch (error) {
    console.error("[GX-ID][QUOTE][ERROR]", error?.message || error);
    try {
      if (m.react) await m.react("☢");
      await m.reply(te(m.prefix, m.command, m.pushName));
    } catch {}
  }
}

export { pluginConfig as config, handler, collectBubbles };
