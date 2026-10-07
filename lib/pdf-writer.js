/**
 * GX-ID — minimal PDF writer
 *
 * A tiny, dependency-free PDF generator used by the `/pdf` converter for the
 * cases that do NOT need an office suite:
 *
 *   • text-like input  (txt, md, csv, log, json …)  → paginated text pages
 *   • raster images    (jpg, png, webp, gif …)      → one full-page JPEG
 *
 * It emits a well-formed PDF 1.4 document (catalog → pages → page objects with
 * Helvetica text or an embedded JPEG XObject) so the output opens in any
 * reader. Office formats (docx/pptx/xlsx …) are handled elsewhere by
 * LibreOffice — see `lib/pdf-convert.js`.
 *
 * Only the 14 standard fonts are referenced (no font embedding) which keeps the
 * output tiny. Characters outside WinAnsi are replaced with `?`.
 */

/** A4 in PostScript points. */
export const A4 = { width: 595.28, height: 841.89 };

const DEFAULT_FONT_SIZE = 11;
const DEFAULT_MARGIN = 50;
const LINE_FACTOR = 1.45;

/* ─────────────────────────────── text metrics ─────────────────────────────── */

// Coarse Helvetica advance widths (fraction of the font size). Good enough for
// word wrapping without shipping the full AFM table.
const NARROW = new Set("iljt.,;:!|'`\"[](){}fr-".split(""));
const WIDE = new Set("mwMW@%&".split(""));

function charWidth(ch, size) {
  if (ch === " ") return size * 0.28;
  if (NARROW.has(ch)) return size * 0.3;
  if (WIDE.has(ch)) return size * 0.82;
  if (ch >= "A" && ch <= "Z") return size * 0.66;
  return size * 0.52;
}

/** Approximate rendered width of `text` at `size` points. */
export function measureText(text, size = DEFAULT_FONT_SIZE) {
  let width = 0;
  for (const ch of String(text)) width += charWidth(ch, size);
  return width;
}

/**
 * Word-wrap `text` to `maxWidth` points, preserving explicit line breaks.
 * Words longer than a line are hard-broken.
 */
export function wrapText(text, size = DEFAULT_FONT_SIZE, maxWidth = A4.width - DEFAULT_MARGIN * 2) {
  const lines = [];
  for (const rawLine of String(text).replace(/\r\n?/g, "\n").split("\n")) {
    if (rawLine.trim() === "") {
      lines.push("");
      continue;
    }
    let line = "";
    for (const word of rawLine.split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (measureText(candidate, size) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      if (measureText(word, size) > maxWidth) {
        let chunk = "";
        for (const ch of word) {
          if (chunk && measureText(chunk + ch, size) > maxWidth) {
            lines.push(chunk);
            chunk = ch;
          } else {
            chunk += ch;
          }
        }
        line = chunk;
      } else {
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

/** Escape a string for a PDF literal string and map it to WinAnsi. */
function pdfString(value) {
  return String(value)
    .replace(/[^\x00-\xFF]/g, "?")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

/** Split wrapped lines into pages of at most `perPage` lines. */
function paginate(lines, perPage) {
  if (lines.length === 0) return [[]];
  const pages = [];
  for (let i = 0; i < lines.length; i += perPage) pages.push(lines.slice(i, i + perPage));
  return pages;
}

/* ─────────────────────────────── assembly ─────────────────────────────── */

/**
 * Assemble a PDF from an ordered list of object bodies (Buffers).
 * Object numbers are 1-based and match their position in `bodies`.
 */
function assemble(bodies, rootNum = 1) {
  const chunks = [];
  let offset = 0;
  const push = (buf) => {
    chunks.push(buf);
    offset += buf.length;
  };

  push(Buffer.from("%PDF-1.4\n", "latin1"));
  // Binary marker comment so tools treat the file as binary.
  push(Buffer.from([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  const offsets = [0];
  bodies.forEach((body, index) => {
    const num = index + 1;
    offsets[num] = offset;
    push(Buffer.from(`${num} 0 obj\n`, "latin1"));
    push(body);
    push(Buffer.from("\nendobj\n", "latin1"));
  });

  const xrefStart = offset;
  let xref = `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= bodies.length; i++) {
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  push(Buffer.from(xref, "latin1"));
  push(
    Buffer.from(
      `trailer\n<< /Size ${bodies.length + 1} /Root ${rootNum} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`,
      "latin1",
    ),
  );

  return Buffer.concat(chunks);
}

/**
 * Build a document from page descriptors.
 *
 * @param {Array<{type:"text",lines:string[],fontSize:number,leading:number,margin:number}
 *             | {type:"image",data:Buffer,width:number,height:number,margin:number}>} pages
 * @returns {Buffer}
 */
function buildPages(pages) {
  const fontNum = 3; // 1 = catalog, 2 = pages, 3 = font
  let next = 4;

  const planned = pages.map((page) => {
    const contentNum = next++;
    const imageNum = page.type === "image" ? next++ : 0;
    const pageNum = next++;
    return { page, contentNum, imageNum, pageNum };
  });

  const bodies = new Array(next - 1);
  const kids = planned.map((p) => `${p.pageNum} 0 R`).join(" ");

  bodies[0] = Buffer.from(`<< /Type /Catalog /Pages 2 0 R >>`, "latin1");
  bodies[1] = Buffer.from(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`, "latin1");
  bodies[2] = Buffer.from(
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`,
    "latin1",
  );

  for (const { page, contentNum, imageNum, pageNum } of planned) {
    let content = "";
    let resources = `<< /Font << /F1 ${fontNum} 0 R >> >>`;

    if (page.type === "text") {
      const top = A4.height - page.margin - page.fontSize;
      const parts = ["BT", `/F1 ${page.fontSize} Tf`, `${page.leading} TL`, `${page.margin} ${top} Td`];
      for (const line of page.lines) {
        parts.push(`(${pdfString(line)}) Tj`, "T*");
      }
      parts.push("ET");
      content = parts.join("\n");
    } else {
      const scale = Math.min(
        (A4.width - page.margin * 2) / page.width,
        (A4.height - page.margin * 2) / page.height,
      );
      const drawW = page.width * scale;
      const drawH = page.height * scale;
      const x = (A4.width - drawW) / 2;
      const y = (A4.height - drawH) / 2;
      content = `q\n${drawW.toFixed(2)} 0 0 ${drawH.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm\n/Im0 Do\nQ`;
      resources = `<< /XObject << /Im0 ${imageNum} 0 R >> >>`;
    }

    const contentBuf = Buffer.from(content, "latin1");
    bodies[contentNum - 1] = Buffer.concat([
      Buffer.from(`<< /Length ${contentBuf.length} >>\nstream\n`, "latin1"),
      contentBuf,
      Buffer.from("\nendstream", "latin1"),
    ]);

    if (imageNum) {
      const header = Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} ` +
          `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.data.length} >>\nstream\n`,
        "latin1",
      );
      bodies[imageNum - 1] = Buffer.concat([
        header,
        page.data,
        Buffer.from("\nendstream", "latin1"),
      ]);
    }

    bodies[pageNum - 1] = Buffer.from(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4.width} ${A4.height}] ` +
        `/Resources ${resources} /Contents ${contentNum} 0 R >>`,
      "latin1",
    );
  }

  return assemble(bodies);
}

/* ─────────────────────────────── public API ─────────────────────────────── */

/**
 * Render plain text into a paginated A4 PDF.
 *
 * @param {string} text
 * @param {{fontSize?:number, margin?:number}} [options]
 * @returns {Buffer}
 */
export function createTextPdf(text, options = {}) {
  const fontSize = options.fontSize ?? DEFAULT_FONT_SIZE;
  const margin = options.margin ?? DEFAULT_MARGIN;
  const leading = fontSize * LINE_FACTOR;
  const maxWidth = A4.width - margin * 2;
  const perPage = Math.max(1, Math.floor((A4.height - margin * 2) / leading));

  const wrapped = wrapText(text, fontSize, maxWidth);
  const pages = paginate(wrapped, perPage).map((lines) => ({
    type: "text",
    lines,
    fontSize,
    leading,
    margin,
  }));

  return buildPages(pages);
}

/**
 * Render a single JPEG image as a centred, aspect-preserving A4 page.
 *
 * @param {Buffer} jpeg  JPEG bytes (DCTDecode is a passthrough filter).
 * @param {{width:number, height:number, margin?:number}} meta
 * @returns {Buffer}
 */
export function createImagePdf(jpeg, meta) {
  if (!Buffer.isBuffer(jpeg) || jpeg.length === 0) throw new Error("empty image buffer");
  if (!meta?.width || !meta?.height) throw new Error("image dimensions required");
  return buildPages([
    {
      type: "image",
      data: jpeg,
      width: meta.width,
      height: meta.height,
      margin: meta.margin ?? DEFAULT_MARGIN,
    },
  ]);
}
