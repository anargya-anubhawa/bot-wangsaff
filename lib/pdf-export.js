/**
 * GX-ID — PDF → other formats (the inverse of `lib/pdf-convert.js`)
 *
 * Pulls the text out of a PDF (with the dependency-free `lib/pdf-reader.js`)
 * and re-emits it as an editable document:
 *
 *   • Built-in (always available, no external tool):
 *       docx  → `lib/docx-writer.js` (a real OOXML package)
 *       txt / md / html / rtf → straightforward text re-encoding
 *   • LibreOffice (auto-detected, optional):
 *       png / jpg → the first page rendered as an image
 *
 * Scanned/image-only PDFs contain no extractable text. Rather than hand back an
 * empty document, the text targets throw an actionable error; `renderPdfPage()`
 * (image targets) still works because it rasterises instead of reading text.
 */
import { logger } from "./logger.js";
import { extractPdfText } from "./pdf-reader.js";
import { createDocx } from "./docx-writer.js";
import { findLibreOffice, isLibreOfficeAvailable, convertWithLibreOffice, getLimits } from "./pdf-convert.js";

/* ─────────────────────────────── targets ─────────────────────────────── */

/**
 * The formats the user can pick. `engine` decides how the file is produced:
 *   "text"        → built-in, from the extracted text
 *   "libreoffice" → rendered by LibreOffice (images)
 */
export const PDF_EXPORT_TARGETS = [
  {
    id: "docx",
    label: "DOCX",
    ext: "docx",
    emoji: "📘",
    engine: "text",
    description: "Word (dapat diedit)",
    mimetype: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  {
    id: "txt",
    label: "TXT",
    ext: "txt",
    emoji: "📄",
    engine: "text",
    description: "Teks polos",
    mimetype: "text/plain",
  },
  {
    id: "md",
    label: "MD",
    ext: "md",
    emoji: "📝",
    engine: "text",
    description: "Markdown",
    mimetype: "text/markdown",
  },
  {
    id: "html",
    label: "HTML",
    ext: "html",
    emoji: "🌐",
    engine: "text",
    description: "Halaman web",
    mimetype: "text/html",
  },
  {
    id: "rtf",
    label: "RTF",
    ext: "rtf",
    emoji: "📃",
    engine: "text",
    description: "Rich Text",
    mimetype: "application/rtf",
  },
  {
    id: "png",
    label: "PNG",
    ext: "png",
    emoji: "🖼️",
    engine: "libreoffice",
    description: "Gambar halaman 1",
    mimetype: "image/png",
  },
  {
    id: "jpg",
    label: "JPG",
    ext: "jpg",
    emoji: "🖼️",
    engine: "libreoffice",
    description: "Gambar halaman 1",
    mimetype: "image/jpeg",
  },
];

/** Look up a target by id (case-insensitive). */
export function getExportTarget(id) {
  const key = String(id || "").trim().toLowerCase();
  return PDF_EXPORT_TARGETS.find((t) => t.id === key) || null;
}

/** The built-in text targets (always available). */
export function textTargets() {
  return PDF_EXPORT_TARGETS.filter((t) => t.engine === "text");
}

/** True when the LibreOffice-backed image targets are usable. */
export function imageTargetsAvailable() {
  return isLibreOfficeAvailable();
}

/* ─────────────────────────── text re-encoders ─────────────────────────── */

/** Escape the characters RTF treats specially; non-ASCII becomes \uN?. */
function escapeRtf(value) {
  return String(value ?? "").replace(/[\\{}]/g, (c) => `\\${c}`).replace(/[^\x00-\x7F]/g, (c) => {
    const code = c.charCodeAt(0);
    return code > 0xffff ? `\\u${code - 0x10000}?` : `\\u${code}?`;
  });
}

/** Escape HTML special characters. */
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Plain text: pages separated by a blank line. */
function toText(pages) {
  return pages.join("\n\n");
}

/** Markdown: pages separated by a horizontal rule. */
function toMarkdown(pages) {
  return pages.map((p, i) => (i === 0 ? p : `---\n\n${p}`)).join("\n\n");
}

/** HTML: one <p> per line, one <section> per page. */
function toHtml(pages, title) {
  const sections = pages
    .map((page) => {
      const paras = page
        .split("\n")
        .map((line) => (line.trim() ? `<p>${escapeHtml(line)}</p>` : "<p>&nbsp;</p>"))
        .join("\n");
      return `<section>\n${paras}\n</section>`;
    })
    .join("\n");
  return `<!DOCTYPE html>\n<html lang="id">\n<head>\n<meta charset="utf-8">\n<title>${escapeHtml(
    title || "PDF",
  )}</title>\n<style>body{font-family:Arial,Helvetica,sans-serif;line-height:1.5;max-width:800px;margin:2rem auto;padding:0 1rem}p{margin:0 0 .5rem}</style>\n</head>\n<body>\n${sections}\n</body>\n</html>\n`;
}

/** RTF: one paragraph per line, pages separated by a page break. */
function toRtf(pages, title) {
  const body = pages
    .map((page, index) => {
      const paras = page
        .split("\n")
        .map((line) => `${escapeRtf(line)}\\par\n`)
        .join("");
      const breakPage = index > 0 ? "\\page\n" : "";
      return `${breakPage}${paras}`;
    })
    .join("");
  return `{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0\\fnil Calibri;}}\\f0\\fs22\n${escapeRtf(
    title || "PDF",
  )}\\par\n\\par\n${body}}\n`;
}

/* ─────────────────────────── renderers ─────────────────────────── */

/** Build the text-family output for a target from the extracted pages. */
function renderTextTarget(target, pages, fileName) {
  const title = String(fileName || "").replace(/\.[^.]*$/, "");
  switch (target.id) {
    case "docx":
      return createDocx(toText(pages), { title });
    case "txt":
      return Buffer.from(toText(pages), "utf8");
    case "md":
      return Buffer.from(toMarkdown(pages), "utf8");
    case "html":
      return Buffer.from(toHtml(pages, title), "utf8");
    case "rtf":
      return Buffer.from(toRtf(pages, title), "latin1");
    default:
      throw new Error(`Format "${target.id}" tidak didukung.`);
  }
}

/**
 * Render the first page of a PDF to an image with LibreOffice.
 * (LibreOffice's PDF import is Draw-based, so it exports a single page.)
 */
async function renderPdfPage(buffer, target, timeoutMs) {
  if (!isLibreOfficeAvailable()) {
    throw new Error(
      `Format ${target.label} butuh LibreOffice (belum terpasang). ` +
        `Pasang LibreOffice atau set LIBREOFFICE_PATH, lalu coba lagi.`,
    );
  }
  const filter = target.id === "jpg" ? "jpg" : "png";
  return convertWithLibreOffice(buffer, "pdf", filter, { timeoutMs });
}

/* ─────────────────────────────── public API ─────────────────────────────── */

/**
 * Convert a PDF into `target`.
 *
 * @param {Buffer} buffer
 * @param {string|object} target  a target id or a target descriptor
 * @param {{fileName?:string, timeoutMs?:number}} [options]
 * @returns {Promise<{buffer:Buffer, extension:string, mimetype:string,
 *                    engine:string, pageCount:number, pagesWithText:number,
 *                    warning:string|null}>}
 */
export async function convertFromPdf(buffer, target, options = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error("File kosong.");

  const limits = getLimits();
  if (buffer.length > limits.maxBytes) {
    const mb = (limits.maxBytes / 1024 / 1024).toFixed(0);
    throw new Error(`File terlalu besar (maks ${mb} MB).`);
  }

  const descriptor = typeof target === "string" ? getExportTarget(target) : target;
  if (!descriptor) throw new Error("Format tujuan tidak dikenal.");
  const timeoutMs = options.timeoutMs || limits.timeoutMs;

  if (descriptor.engine === "libreoffice") {
    const out = await renderPdfPage(buffer, descriptor, timeoutMs);
    return {
      buffer: out,
      extension: descriptor.ext,
      mimetype: descriptor.mimetype,
      engine: "libreoffice",
      pageCount: 1,
      pagesWithText: 0,
      warning: "Hanya halaman pertama yang dirender ke gambar.",
    };
  }

  const parsed = extractPdfText(buffer);
  if (!parsed.ok) throw new Error(parsed.error || "Gagal membaca PDF.");
  if (!parsed.pagesWithText) {
    throw new Error(
      "PDF ini tidak berisi teks yang bisa diambil (kemungkinan hasil scan/gambar). " +
        "Coba ubah ke PNG/JPG untuk melihat tampilannya, atau gunakan OCR terlebih dahulu.",
    );
  }

  const out = renderTextTarget(descriptor, parsed.pages, options.fileName);
  const warning =
    parsed.pagesWithText < parsed.pageCount
      ? `${parsed.pageCount - parsed.pagesWithText} dari ${parsed.pageCount} halaman tidak berisi teks (gambar) dan dilewati.`
      : null;

  logger.info(`pdf-export: ${descriptor.id} · ${parsed.pagesWithText}/${parsed.pageCount} halaman berteks`);
  return {
    buffer: out,
    extension: descriptor.ext,
    mimetype: descriptor.mimetype,
    engine: "builtin-text",
    pageCount: parsed.pageCount,
    pagesWithText: parsed.pagesWithText,
    warning,
  };
}
