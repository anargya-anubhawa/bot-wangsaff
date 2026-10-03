/**
 * ALTHEORA — /ipkfkikumy
 *
 * Mengambil dokumen transkrip (PDF) dari SIMAK FKIK UMY berdasarkan NIM,
 * lalu mengirimkannya ke chat.
 *
 * Usage:
 *   .ipkfkikumy 20250310001      → ambil & kirim PDF transkrip NIM tsb
 *   .ipkfkikumy -owner           → hanya Owner/Partner yang boleh menjalankan
 *   .ipkfkikumy -public          → semua orang boleh menjalankan
 *   .ipkfkikumy -status          → lihat mode akses saat ini
 *
 * File ini HANYA mengurus alur command & validasi. Semua logika request
 * (cloudscraper, Cloudflare bypass, validasi PDF) ada di modul terpisah
 * `simak-fkik.js`.
 */

import { getDatabase } from "../../src/lib/GX-database.js";
import {
  simakLog,
  normalizeNim,
  isValidNim,
  fetchTranscriptPdf,
  getAccessMode,
  setAccessMode,
} from "./simak-fkik.js";

const pluginConfig = {
  name: "ip",
  alias: [
    "transkripfkik",
    "transkripumy",
    "ipkumy",
    "simakfkik",
    "transkripfkikumy",
  ],
  category: "altheora",
  description: "Ambil & kirim PDF transkrip mahasiswa FKIK UMY dari SIMAK",
  usage: ".ipkfkikumy <nim> | -owner | -public | -status",
  example: ".ipkfkikumy 20250310001",
  helpOnEmpty: false,
  isOwner: false,
  isPremium: false,
  isGroup: false,
  isPrivate: false,
  isAdmin: false,
  isBotAdmin: false,
  cooldown: 10,
  energi: 0,
  isEnabled: true,
};

const ACTION_RE = /^-{1,2}(owner|public|status|help)$/i;

/**
 * Cek apakah pengirim boleh mengubah mode akses.
 * @param {object} m
 * @returns {boolean}
 */
function isPrivileged(m) {
  return Boolean(m.isOwner || m.isPartner);
}

/**
 * Render bantuan singkat.
 * @param {string} prefix
 * @param {"owner"|"public"} mode
 * @returns {string}
 */
function renderHelp(prefix = ".", mode = "owner") {
  const modeLabel = mode === "public" ? "PUBLIC (semua orang)" : "OWNER ONLY";
  return [
    "🎓 *ALTHEORA — TRANSKRIP FKIK UMY*",
    "━━━━━━━━━━━━━━━━━━━━━━━━",
    "*Cara pakai:*",
    `> \`${prefix}ipkfkikumy <nim>\`  → ambil & kirim PDF transkrip`,
    `> Contoh: \`${prefix}ipkfkikumy 20250310001\``,
    "",
    "*Pengaturan akses (Owner/Partner):*",
    `> \`${prefix}ipkfkikumy -owner\`   → hanya Owner/Partner`,
    `> \`${prefix}ipkfkikumy -public\`  → semua orang`,
    `> \`${prefix}ipkfkikumy -status\`  → lihat mode sekarang`,
    "━━━━━━━━━━━━━━━━━━━━━━━━",
    `🔐 Mode saat ini: *${modeLabel}*`,
  ].join("\n");
}

/**
 * Handler /ipkfkikumy
 */
async function handler(m, { sock, args = [], text = "", db: ctxDb } = {}) {
  const prefix = m.prefix || ".";
  const db = ctxDb || getDatabase();

  const argv = (args.length ? args : String(text).split(/\s+/)).filter(
    (a) => a !== "",
  );

  // ── Tanpa argumen → bantuan ────────────────────────────────────────────
  if (argv.length === 0) {
    return m.reply(renderHelp(prefix, getAccessMode(db)));
  }

  const first = String(argv[0] || "").trim();

  // ── Mode akses: -owner / -public ────────────────────────────────────────
  if (ACTION_RE.test(first)) {
    const action = first.toLowerCase().replace(/^-{1,2}/, "");

    if (action === "help") {
      return m.reply(renderHelp(prefix, getAccessMode(db)));
    }

    // Semua sub-perintah pengaturan hanya untuk Owner/Partner.
    if (!isPrivileged(m)) {
      return m.reply(
        "🔒 *Akses ditolak.*\n\n> Hanya Owner/Partner yang bisa mengubah akses command ini.",
      );
    }

    if (action === "status") {
      const mode = getAccessMode(db);
      const modeLabel =
        mode === "public" ? "PUBLIC (semua orang)" : "OWNER ONLY";
      return m.reply(
        "🔐 *STATUS AKSES — ipkfkikumy*\n\n" +
          `> Mode: *${modeLabel}*\n` +
          `> Ubah: \`${prefix}ipkfkikumy -owner\` / \`${prefix}ipkfkikumy -public\``,
      );
    }

    const mode = setAccessMode(db, action === "public" ? "public" : "owner");
    await db.save?.();
    await m.react("✅").catch(() => {});
    simakLog("CMD", "info", `akses diubah ke ${mode} oleh ${m.sender}`);

    const modeLabel =
      mode === "public" ? "PUBLIC (semua orang)" : "OWNER ONLY";
    return m.reply(
      "✅ *Akses command diubah.*\n\n" +
        `> Mode baru: *${modeLabel}*\n` +
        `> Contoh: \`${prefix}ipkfkikumy 20250310001\``,
    );
  }

  // ── Cek izin menjalankan berdasarkan mode tersimpan ──────────────────────
  const mode = getAccessMode(db);
  if (mode === "owner" && !isPrivileged(m)) {
    return m.reply(
      "🔒 *Command ini sedang dibatasi.*\n\n" +
        "> Saat ini hanya Owner/Partner yang bisa memakai command ini.",
    );
  }

  // ── Ambil & validasi NIM ────────────────────────────────────────────────
  const nim = normalizeNim(first);
  if (!isValidNim(nim)) {
    return m.reply(
      "⚠️ *NIM tidak valid.*\n\n" +
        "> Kirim NIM berupa angka (contoh: `20250310001`).\n" +
        `> Format: \`${prefix}ipkfkikumy <nim>\``,
    );
  }

  await m.react("🕕").catch(() => {});
  await m.reply(
    "🕕 *Mengambil transkrip...*\n\n" +
      `> NIM: \`${nim}\`\n> Mohon tunggu sebentar.`,
  );

  try {
    const result = await fetchTranscriptPdf(nim);

    if (!result.ok) {
      await m.react("❌").catch(() => {});
      simakLog("CMD", "warn", `gagal ambil ${nim}: ${result.code}`);
      return m.reply(
        `❌ *Gagal mengambil transkrip.*\n\n> ${result.message}\n> NIM: \`${nim}\``,
      );
    }

    const fileName = `transkrip-${nim}.pdf`;
    await sock.sendMessage(
      m.chat,
      {
        document: result.buffer,
        mimetype: "application/pdf",
        fileName,
        caption:
          "🎓 *TRANSKRIP FKIK UMY*\n\n" +
          `> NIM: \`${nim}\`\n` +
          `> 📄 Ukuran: ${(result.bytes / 1024).toFixed(1)} KB`,
      },
      { quoted: m },
    );

    await m.react("✅").catch(() => {});
    simakLog(
      "CMD",
      "success",
      `terkirim ${nim} (${result.bytes} byte) oleh ${m.sender}`,
    );
    return;
  } catch (e) {
    const brief = String(e?.message || e || "unknown").slice(0, 160);
    simakLog("CMD", "error", `error: ${brief}`);
    await m.react("☢").catch(() => {});
    return m.reply(
      "☢ *Gagal memproses permintaan.*\n\n" +
        `> ${brief}\n\n> Coba lagi beberapa saat.`,
    );
  }
}

export { pluginConfig as config, handler, renderHelp, isPrivileged };
