/**
 * ALTHEORA — SIMAK FKIK UMY transcript fetcher.
 *
 * Mengambil dokumen transkrip (PDF) dari SIMAK FKIK UMY berdasarkan NIM:
 *   https://simak-fkik.umy.ac.id/Akademik/Transkrip/UnivTranskripDocx?nim=<NIM>
 *
 * Situs ini dilindungi Cloudflare + WAF kustom, sehingga request biasa
 * (fetch/axios) diblokir dengan halaman "Security Block". Karena itu permintaan
 * dikirim lewat `cloudscraper` (sudah tersedia sebagai dependency GX-ID) agar
 * bisa lolos challenge Cloudflare tanpa browser/API berbayar.
 *
 * Modul ini SENGAJA tidak mengekspor { config, handler }, jadi otomatis
 * dilewati oleh plugin loader GX-ID — hanya dipakai sebagai helper oleh
 * command `ipkfkikumy.js`.
 */

import fs from "fs";
import path from "path";
import cloudscraper from "cloudscraper";
import { logger } from "../../src/lib/GX-logger.js";

// ── .env loader (Node >= 20.12 punya process.loadEnvFile) ──────────────────
try {
  const envPath = path.join(process.cwd(), ".env");
  if (fs.existsSync(envPath) && typeof process.loadEnvFile === "function") {
    process.loadEnvFile(envPath);
  }
} catch {
  /* .env opsional — abaikan kalau gagal */
}

function envStr(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined || raw === null) return fallback;
  const val = String(raw).trim();
  return val === "" ? fallback : val;
}

function envInt(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return fallback;
  }
  const n = Number.parseInt(String(raw).trim(), 10);
  return Number.isFinite(n) ? n : fallback;
}

// ── Config utama ───────────────────────────────────────────────────────────
const simakConfig = {
  /** Base URL SIMAK FKIK UMY. */
  baseUrl: envStr("SIMAK_BASE_URL", "https://simak-fkik.umy.ac.id"),

  /** Endpoint dokumen transkrip. */
  endpoint: envStr("SIMAK_ENDPOINT", "/Akademik/Transkrip/UnivTranskripDocx"),

  /** Timeout request (ms). */
  timeoutMs: envInt("SIMAK_TIMEOUT_MS", 45000),

  /** Batas ukuran PDF yang diterima (byte). */
  maxPdfBytes: envInt("SIMAK_MAX_PDF_BYTES", 20 * 1024 * 1024),

  /** Jumlah percobaan saat kena blokir/transient (min 1). */
  retries: envInt("SIMAK_RETRIES", 2),

  /** Panjang NIM yang dianggap valid (digit). */
  nimMin: envInt("SIMAK_NIM_MIN", 5),
  nimMax: envInt("SIMAK_NIM_MAX", 20),

  /** Mode akses default bila belum pernah diatur: "owner" | "public". */
  defaultAccess:
    String(envStr("SIMAK_DEFAULT_ACCESS", "owner")).toLowerCase() === "public"
      ? "public"
      : "owner",

  /** Kunci penyimpanan mode akses di lowdb settings. */
  accessKey: "altheora_simak_access",

  /** User-Agent browser agar terlihat seperti akses manusia. */
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
};

const PDF_MAGIC = "%PDF-";

// ── Logger bertag ──────────────────────────────────────────────────────────
/**
 * Logger bertag untuk modul ini.
 * @param {string} scope  mis. "FETCH", "CMD"
 * @param {"info"|"success"|"warn"|"error"} kind
 * @param {string} message
 */
function simakLog(scope, kind, message) {
  const label = `[ALTHEORA][SIMAK][${String(scope || "GEN").toUpperCase()}]`;
  const fn =
    typeof logger?.[kind] === "function" ? logger[kind] : logger.info;
  try {
    fn(label, message);
  } catch {
    /* logger tidak boleh bikin crash */
  }
}

// ── Validasi & URL ─────────────────────────────────────────────────────────
/**
 * Bersihkan input NIM: buang spasi, hanya sisakan digit.
 * @param {string} raw
 * @returns {string} digit murni, atau "" bila ada karakter non-digit
 */
function normalizeNim(raw) {
  const s = String(raw ?? "")
    .trim()
    .replace(/\s+/g, "");
  return /^\d+$/.test(s) ? s : "";
}

/**
 * Cek apakah NIM valid (digit murni + panjang wajar).
 * @param {string} nim
 * @returns {boolean}
 */
function isValidNim(nim) {
  const s = String(nim ?? "").trim();
  if (!/^\d+$/.test(s)) return false;
  return s.length >= simakConfig.nimMin && s.length <= simakConfig.nimMax;
}

/**
 * Susun URL dokumen transkrip untuk NIM tertentu.
 * @param {string} nim
 * @returns {string}
 */
function buildTranscriptUrl(nim) {
  const base = simakConfig.baseUrl.replace(/\/+$/, "");
  const endpoint = simakConfig.endpoint.startsWith("/")
    ? simakConfig.endpoint
    : "/" + simakConfig.endpoint;
  return `${base}${endpoint}?nim=${encodeURIComponent(nim)}`;
}

/**
 * Cek magic bytes PDF.
 * @param {Buffer} buf
 * @returns {boolean}
 */
function isPdfBuffer(buf) {
  return (
    Buffer.isBuffer(buf) &&
    buf.length >= PDF_MAGIC.length &&
    buf.slice(0, PDF_MAGIC.length).toString("latin1") === PDF_MAGIC
  );
}

/**
 * Deteksi halaman blokir Cloudflare/WAF.
 * @param {string} text
 * @returns {boolean}
 */
function looksLikeBlockPage(text) {
  const t = String(text || "").toLowerCase();
  return (
    t.includes("security block") ||
    t.includes("security service to protect") ||
    t.includes("__cf$cv$params") ||
    t.includes("challenge-platform")
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Fetch PDF ──────────────────────────────────────────────────────────────
/**
 * Ambil PDF transkrip dari SIMAK untuk NIM tertentu.
 *
 * @param {string} nim
 * @returns {Promise<{ok:true, buffer:Buffer, contentType:string, bytes:number, url:string}
 *   | {ok:false, code:string, message:string}>}
 */
async function fetchTranscriptPdf(nim) {
  const url = buildTranscriptUrl(nim);
  const attempts = Math.max(1, simakConfig.retries);
  let lastErr = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      simakLog("FETCH", "info", `GET ${url} (attempt ${attempt}/${attempts})`);
      const res = await cloudscraper.get({
        uri: url,
        encoding: null,
        resolveWithFullResponse: true,
        // Jangan throw pada status non-2xx — kita tangani sendiri di bawah.
        simple: false,
        timeout: simakConfig.timeoutMs,
        headers: {
          "User-Agent": simakConfig.userAgent,
          Accept:
            "application/pdf,application/octet-stream,text/html;q=0.9,*/*;q=0.8",
          "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
          Referer: `${simakConfig.baseUrl.replace(/\/+$/, "")}/`,
        },
      });

      const status = Number(res?.statusCode || 0);
      const contentType = String(
        res?.headers?.["content-type"] || "",
      ).toLowerCase();
      const body = Buffer.isBuffer(res?.body)
        ? res.body
        : Buffer.from(res?.body || []);

      // ── Sukses: PDF valid ────────────────────────────────────────────────
      if (status === 200 && isPdfBuffer(body)) {
        if (body.length > simakConfig.maxPdfBytes) {
          const mb = (simakConfig.maxPdfBytes / 1024 / 1024).toFixed(0);
          return {
            ok: false,
            code: "TOO_LARGE",
            message: `Ukuran PDF melebihi batas (maks ${mb} MB).`,
          };
        }
        return {
          ok: true,
          buffer: body,
          contentType: contentType || "application/pdf",
          bytes: body.length,
          url,
        };
      }

      const headText = body.slice(0, 4096).toString("utf8");

      // ── Diblokir WAF/Cloudflare → coba lagi ──────────────────────────────
      if (status === 403 || status === 429 || looksLikeBlockPage(headText)) {
        lastErr = {
          code: "BLOCKED",
          message: "Akses diblokir oleh proteksi server (WAF/Cloudflare).",
        };
        simakLog("FETCH", "warn", `blocked (status ${status}) attempt ${attempt}`);
        if (attempt < attempts) await sleep(800 * attempt);
        continue;
      }

      // ── NIM tidak ditemukan ──────────────────────────────────────────────
      if (status === 404 || status === 500) {
        return {
          ok: false,
          code: "NOT_FOUND",
          message:
            "Data transkrip tidak ditemukan untuk NIM tersebut.\n> Pastikan NIM benar dan sudah terdaftar.",
        };
      }

      // ── 200 tapi bukan PDF (halaman login/error) ─────────────────────────
      if (status === 200 && !isPdfBuffer(body)) {
        return {
          ok: false,
          code: "NOT_PDF",
          message:
            "Server tidak mengembalikan PDF.\n> Kemungkinan NIM salah atau halaman login.",
        };
      }

      lastErr = {
        code: `HTTP_${status}`,
        message: `Server merespons dengan status ${status}.`,
      };
      if (attempt < attempts) await sleep(500 * attempt);
    } catch (e) {
      // Sebagian versi cloudscraper/request tetap throw pada non-2xx dan
      // menyertakan body HTML raksasa di dalam e.message. Tangani status yang
      // menempel di error, dan potong pesan agar tidak membanjiri log/chat.
      const errStatus = Number(
        e?.statusCode || e?.status || e?.response?.statusCode || 0,
      );
      if (errStatus === 404 || errStatus === 500) {
        return {
          ok: false,
          code: "NOT_FOUND",
          message:
            "Data transkrip tidak ditemukan untuk NIM tersebut.\n> Pastikan NIM benar dan sudah terdaftar.",
        };
      }
      if (errStatus === 403 || errStatus === 429) {
        lastErr = {
          code: "BLOCKED",
          message: "Akses diblokir oleh proteksi server (WAF/Cloudflare).",
        };
        simakLog(
          "FETCH",
          "warn",
          `blocked (status ${errStatus}) attempt ${attempt}`,
        );
        if (attempt < attempts) await sleep(800 * attempt);
        continue;
      }
      const brief = String(e?.message || e || "unknown").slice(0, 160);
      lastErr = {
        code: "NETWORK",
        message: `Gagal menghubungi server: ${brief}`,
      };
      simakLog("FETCH", "error", `network error: ${brief}`);
      if (attempt < attempts) await sleep(500 * attempt);
    }
  }

  return {
    ok: false,
    ...(lastErr || {
      code: "UNKNOWN",
      message: "Gagal mengambil PDF dari server.",
    }),
  };
}

// ── Mode akses (disimpan di DB lewat abstraksi GX-ID) ──────────────────────
/**
 * Ambil mode akses saat ini dari DB.
 * @param {object} db  instance database GX-ID
 * @returns {"owner"|"public"}
 */
function getAccessMode(db) {
  const raw = String(db?.setting?.(simakConfig.accessKey) ?? "").toLowerCase();
  if (raw === "public" || raw === "owner") return raw;
  return simakConfig.defaultAccess;
}

/**
 * Set mode akses (owner/public) di DB. Tidak otomatis save().
 * @param {object} db
 * @param {"owner"|"public"} mode
 * @returns {"owner"|"public"}
 */
function setAccessMode(db, mode) {
  const value = mode === "public" ? "public" : "owner";
  db?.setting?.(simakConfig.accessKey, value);
  return value;
}

export {
  simakConfig,
  simakLog,
  normalizeNim,
  isValidNim,
  buildTranscriptUrl,
  isPdfBuffer,
  looksLikeBlockPage,
  fetchTranscriptPdf,
  getAccessMode,
  setAccessMode,
};
