/**
 * GX-ID — local document → PDF converter
 *
 * Converts a downloaded document into a PDF **on the bot host** and returns the
 * resulting buffer. Two engines are available:
 *
 *   1. LibreOffice (`soffice --headless`) — required for office formats
 *      (docx, doc, pptx, ppt, xlsx, xls, odt, odp, ods, rtf …). It is
 *      auto-detected on PATH and in the usual install locations, and can be
 *      pinned with the `LIBREOFFICE_PATH` environment variable.
 *   2. A built-in, dependency-free writer (`lib/pdf-writer.js`) — used for
 *      raster images (jpg, png, webp, gif …) and text-like files
 *      (txt, md, csv, log, json …) so those work with **no** system package.
 *
 * Nothing here ever throws for "LibreOffice missing" on an unsupported format
 * without first explaining *why*: callers receive an `Error` whose message is
 * safe to show to the user.
 */
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { spawn } from "child_process";
import { pathToFileURL } from "url";
import { logger } from "./logger.js";
import { createTextPdf, createImagePdf } from "./pdf-writer.js";

/* ─────────────────────────────── formats ─────────────────────────────── */

/** Formats LibreOffice converts best (office documents + rich text). */
export const OFFICE_EXTENSIONS = new Set([
  "doc", "docx", "docm", "dot", "dotx",
  "ppt", "pptx", "pptm", "pps", "ppsx",
  "xls", "xlsx", "xlsm", "xlt", "xltx",
  "odt", "ott", "odp", "otp", "ods", "ots",
  "rtf", "wpd", "wps", "pages", "key", "numbers",
  "html", "htm", "xhtml",
]);

/** Raster images handled by the built-in writer (via sharp). */
export const IMAGE_EXTENSIONS = new Set([
  "jpg", "jpeg", "png", "webp", "gif", "bmp", "tif", "tiff", "avif", "heic", "heif",
]);

/** Text-like files handled by the built-in writer. */
export const TEXT_EXTENSIONS = new Set([
  "txt", "text", "md", "markdown", "csv", "tsv", "log", "json", "xml", "yml", "yaml",
  "ini", "cfg", "conf", "env", "js", "ts", "mjs", "cjs", "css", "sql", "sh", "bat", "ps1",
]);

/** MIME hints → extension, for documents sent without a usable filename. */
const MIME_EXTENSION = {
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.oasis.opendocument.text": "odt",
  "application/vnd.oasis.opendocument.presentation": "odp",
  "application/vnd.oasis.opendocument.spreadsheet": "ods",
  "application/rtf": "rtf",
  "text/rtf": "rtf",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
  "application/json": "json",
  "text/html": "html",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "image/avif": "avif",
};

/** Lower-case extension (without dot) of a filename, or "" when absent. */
export function extensionOf(fileName = "") {
  const base = String(fileName).split(/[\\/]/).pop() || "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

/** Resolve the extension from a filename, falling back to the MIME type. */
export function resolveExtension(fileName = "", mimetype = "") {
  const fromName = extensionOf(fileName);
  if (fromName) return fromName;
  const clean = String(mimetype).split(";")[0].trim().toLowerCase();
  return MIME_EXTENSION[clean] || "";
}

/** Format family of an extension: "office" | "image" | "text" | "pdf" | null. */
export function classifyExtension(ext) {
  const e = String(ext || "").toLowerCase();
  if (!e) return null;
  if (e === "pdf") return "pdf";
  if (OFFICE_EXTENSIONS.has(e)) return "office";
  if (IMAGE_EXTENSIONS.has(e)) return "image";
  if (TEXT_EXTENSIONS.has(e)) return "text";
  return null;
}

/* ─────────────────────────────── limits ─────────────────────────────── */

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Runtime limits, overridable through `.env`. */
export function getLimits() {
  return {
    maxBytes: num(process.env.PDF_MAX_SIZE_MB, 25) * 1024 * 1024,
    timeoutMs: num(process.env.PDF_TIMEOUT_MS, 90000),
  };
}

/* ─────────────────────────── LibreOffice detection ─────────────────────────── */

const WINDOWS_CANDIDATES = [
  "C:/Program Files/LibreOffice/program/soffice.exe",
  "C:/Program Files (x86)/LibreOffice/program/soffice.exe",
  "C:/Program Files/LibreOffice 7/program/soffice.exe",
  "C:/Program Files/LibreOffice 24/program/soffice.exe",
];

const UNIX_CANDIDATES = [
  "/usr/bin/soffice",
  "/usr/bin/libreoffice",
  "/usr/local/bin/soffice",
  "/opt/libreoffice/program/soffice",
  "/snap/bin/libreoffice",
  "/Applications/LibreOffice.app/Contents/MacOS/soffice",
];

function exists(file) {
  try {
    return Boolean(file) && fs.existsSync(file);
  } catch {
    return false;
  }
}

let cachedSoffice; // string | null | undefined (undefined = not resolved yet)

/**
 * Locate the LibreOffice binary. Honours `LIBREOFFICE_PATH`, then common
 * install locations, then a PATH lookup. Result is cached.
 * @returns {string|null}
 */
export function findLibreOffice() {
  if (cachedSoffice !== undefined) return cachedSoffice;

  const override = process.env.LIBREOFFICE_PATH;
  if (override && exists(override)) {
    cachedSoffice = override;
    return cachedSoffice;
  }

  const candidates = process.platform === "win32" ? WINDOWS_CANDIDATES : UNIX_CANDIDATES;
  for (const candidate of candidates) {
    if (exists(candidate)) {
      cachedSoffice = candidate;
      return cachedSoffice;
    }
  }

  const pathExt = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  const names = process.platform === "win32" ? ["soffice", "libreoffice"] : ["soffice", "libreoffice"];
  for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      for (const ext of pathExt) {
        const full = path.join(dir, name + ext);
        if (exists(full)) {
          cachedSoffice = full;
          return cachedSoffice;
        }
      }
    }
  }

  cachedSoffice = null;
  return cachedSoffice;
}

/** True when LibreOffice is available for office-format conversion. */
export function isLibreOfficeAvailable() {
  return Boolean(findLibreOffice());
}

/** Test helper — forget the cached LibreOffice lookup. */
export function resetLibreOfficeCache() {
  cachedSoffice = undefined;
}

/* ─────────────────────────────── LibreOffice run ─────────────────────────────── */

function runSoffice(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      reject(new Error("Conversion timed out"));
    }, timeoutMs);

    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `LibreOffice exited with code ${code}`));
    });
  });
}

/**
 * Convert an office document to PDF with LibreOffice headless.
 *
 * A private user-profile directory is used per call so concurrent conversions
 * never clash (LibreOffice refuses to start twice on the same profile).
 */
async function convertWithLibreOffice(buffer, ext, options) {
  const bin = findLibreOffice();
  if (!bin) throw new Error("LibreOffice is not installed");

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "gxid-pdf-"));
  const profileDir = path.join(workDir, "profile");
  const inputPath = path.join(workDir, `input.${ext}`);
  const outputPath = path.join(workDir, `input.pdf`);
  fs.writeFileSync(inputPath, buffer);
  fs.mkdirSync(profileDir, { recursive: true });

  const args = [
    `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
    "--headless",
    "--norestore",
    "--nolockcheck",
    "--nodefault",
    "--nofirststartwizard",
    "--convert-to",
    "pdf",
    "--outdir",
    workDir,
    inputPath,
  ];

  try {
    await runSoffice(bin, args, options.timeoutMs);
    if (!fs.existsSync(outputPath)) throw new Error("LibreOffice produced no output");
    return fs.readFileSync(outputPath);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

/* ─────────────────────────── built-in image / text ─────────────────────────── */

async function convertImage(buffer) {
  const sharp = (await import("sharp")).default;
  // Normalise any input format to baseline JPEG so it can be embedded directly
  // with the /DCTDecode filter (no re-encoding inside the PDF writer).
  const { data, info } = await sharp(buffer, { animated: false })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 90 })
    .toBuffer({ resolveWithObject: true });
  return createImagePdf(data, { width: info.width, height: info.height });
}

function convertText(buffer) {
  let text = buffer.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip BOM
  // Tabs become spaces so the crude text metrics stay predictable.
  text = text.replace(/\t/g, "    ");
  return createTextPdf(text);
}

/* ─────────────────────────────── entry point ─────────────────────────────── */

/**
 * Convert a downloaded document to PDF.
 *
 * @param {Buffer} buffer  raw file bytes
 * @param {{fileName?:string, mimetype?:string, timeoutMs?:number}} [options]
 * @returns {Promise<{buffer:Buffer, engine:string, extension:string}>}
 */
export async function convertToPdf(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error("Empty file");
  }

  const limits = getLimits();
  if (buffer.length > limits.maxBytes) {
    const mb = (limits.maxBytes / 1024 / 1024).toFixed(0);
    throw new Error(`File is too large (max ${mb} MB)`);
  }

  const ext = resolveExtension(options.fileName, options.mimetype);
  const family = classifyExtension(ext);
  const timeoutMs = options.timeoutMs || limits.timeoutMs;

  if (family === "pdf") {
    return { buffer, engine: "passthrough", extension: ext };
  }

  // Images always use the built-in writer: it is instant and dependency-free.
  if (family === "image") {
    return { buffer: await convertImage(buffer), engine: "builtin-image", extension: ext };
  }

  // Text-like files also have a built-in path so they work without LibreOffice.
  if (family === "text") {
    if (isLibreOfficeAvailable()) {
      try {
        return { buffer: await convertWithLibreOffice(buffer, ext, { timeoutMs }), engine: "libreoffice", extension: ext };
      } catch (error) {
        logger.warn(`pdf: LibreOffice text conversion failed, using built-in writer: ${error.message}`);
      }
    }
    return { buffer: convertText(buffer), engine: "builtin-text", extension: ext };
  }

  // Office formats require LibreOffice.
  if (family === "office") {
    if (!isLibreOfficeAvailable()) {
      throw new Error(
        `"${ext.toUpperCase()}" files need LibreOffice, which is not installed on the bot host. ` +
          `Install LibreOffice or set LIBREOFFICE_PATH.`,
      );
    }
    return { buffer: await convertWithLibreOffice(buffer, ext, { timeoutMs }), engine: "libreoffice", extension: ext };
  }

  // Unknown / unsupported extension.
  if (!ext) {
    throw new Error("Could not determine the file type. Send the file with a proper filename.");
  }
  throw new Error(`".${ext}" files are not supported. Supported: Office documents, images, and text files.`);
}

/** Human-readable list of the extensions the converter accepts. */
export function supportedExtensions() {
  return {
    office: [...OFFICE_EXTENSIONS].sort(),
    image: [...IMAGE_EXTENSIONS].sort(),
    text: [...TEXT_EXTENSIONS].sort(),
  };
}
