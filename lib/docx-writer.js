/**
 * GX-ID — minimal DOCX writer
 *
 * Builds a `.docx` (Office Open XML) from plain text with **no** dependency
 * beyond `zlib` (through `lib/zip-writer.js`). A `.docx` is a ZIP containing a
 * handful of XML parts; the smallest package Word, LibreOffice and Google Docs
 * all accept needs just three:
 *
 *   [Content_Types].xml   → declares the main document part
 *   _rels/.rels           → links the package root to word/document.xml
 *   word/document.xml     → the paragraphs themselves
 *
 * Each input line becomes one paragraph, so blank lines are preserved. XML
 * special characters are escaped and characters that are illegal in XML 1.0 are
 * dropped rather than producing a corrupt document.
 */
import { createZip } from "./zip-writer.js";

/** Escape a string for XML text content (and strip illegal control chars). */
export function escapeXml(value) {
  return String(value ?? "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

/** Build one `<w:p>` paragraph, optionally with a style. */
function paragraph(text, style) {
  const pPr = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : "";
  const run = text === "" ? "" : `<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
  return `<w:p>${pPr}${run}</w:p>`;
}

/**
 * Render plain text into a DOCX document.
 *
 * @param {string} text
 * @param {{title?:string}} [options]  optional heading paragraph
 * @returns {Buffer}
 */
export function createDocx(text, options = {}) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const paragraphs = [];
  if (options.title) paragraphs.push(paragraph(String(options.title), "Title"));
  for (const line of lines) paragraphs.push(paragraph(line));

  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W_NS}"><w:body>${paragraphs.join("")}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`;

  return createZip([
    { name: "[Content_Types].xml", data: CONTENT_TYPES },
    { name: "_rels/.rels", data: ROOT_RELS },
    { name: "word/document.xml", data: document },
  ]);
}
