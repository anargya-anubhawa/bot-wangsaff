/**
 * GX-ID — Document → PDF converter test
 *
 * Covers the whole feature without LibreOffice and without a network:
 *   • extension / MIME resolution and format classification
 *   • the dependency-free PDF writer (text + embedded JPEG)
 *   • structural validity of the produced PDFs (header, xref offsets, trailer)
 *   • the converter entry point (passthrough, image, text, unsupported, limits)
 *   • the `.pdf` command registration and its target resolution
 */
import assert from "assert";

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
  }
}

const writer = await import("../lib/pdf-writer.js");
const convert = await import("../lib/pdf-convert.js");

/* ─────────────────────────── PDF structural validator ─────────────────────────── */

/**
 * Parse a PDF buffer and assert its cross-reference table is coherent.
 * Returns the number of objects so callers can make further assertions.
 */
function validatePdf(buffer) {
  assert.ok(Buffer.isBuffer(buffer), "output must be a Buffer");
  assert.ok(buffer.length > 100, "PDF must not be trivially small");

  const text = buffer.toString("latin1");
  assert.ok(text.startsWith("%PDF-1."), "must start with a %PDF header");
  assert.ok(text.trimEnd().endsWith("%%EOF"), "must end with %%EOF");

  const sx = text.lastIndexOf("startxref");
  assert.ok(sx !== -1, "must contain a startxref marker");
  const offset = Number.parseInt(text.slice(sx + "startxref".length).trim().split(/\s+/)[0], 10);
  assert.ok(Number.isInteger(offset) && offset > 0, "startxref must be a positive offset");
  assert.equal(text.slice(offset, offset + 4), "xref", "startxref must point at the xref table");

  // xref header: "xref\n0 <count>\n"
  const head = text.slice(offset, offset + 64).split("\n");
  assert.equal(head[0].trim(), "xref");
  const [, count] = head[1].trim().split(/\s+/);
  const size = Number.parseInt(count, 10);
  assert.ok(size >= 2, "xref must describe at least the free entry + one object");

  // Each entry is 20 bytes: "nnnnnnnnnn ggggg n \n" (10 digits, space, 5 digits, space, type, space, \n)
  const entries = text.slice(offset + head[0].length + 1 + head[1].length + 1, offset + head[0].length + 1 + head[1].length + 1 + size * 20);
  assert.equal(entries.length, size * 20, "xref must contain exactly <count> 20-byte entries");
  assert.match(entries.slice(0, 20), /^0{10} 65535 f /, "entry 0 must be the free object");

  for (let i = 1; i < size; i++) {
    const entry = entries.slice(i * 20, i * 20 + 20);
    assert.match(entry, /^\d{10} \d{5} n \n$/, `entry ${i} must be a well-formed in-use entry`);
    const objOffset = Number.parseInt(entry.slice(0, 10), 10);
    const marker = `${i} 0 obj`;
    assert.equal(text.slice(objOffset, objOffset + marker.length), marker, `xref offset for object ${i} must point at "${marker}"`);
  }

  const trailerIdx = text.lastIndexOf("trailer");
  assert.ok(trailerIdx !== -1, "must contain a trailer");
  const trailer = text.slice(trailerIdx, sx);
  assert.match(trailer, /\/Root \d+ 0 R/, "trailer must reference a Root");
  assert.match(trailer, new RegExp(`/Size ${size}\\b`), "trailer /Size must match the xref count");

  return size;
}

/* ═══════════════════════════ extension helpers ═══════════════════════════ */

await test("extensionOf reads a lower-cased extension", () => {
  assert.equal(convert.extensionOf("Deck.PPTX"), "pptx");
  assert.equal(convert.extensionOf("C:\\docs\\a.b.docx"), "docx");
  assert.equal(convert.extensionOf("archive.tar.gz"), "gz");
  assert.equal(convert.extensionOf("noext"), "");
  assert.equal(convert.extensionOf("trailing."), "");
  assert.equal(convert.extensionOf(""), "");
});

await test("resolveExtension falls back to the MIME type", () => {
  assert.equal(convert.resolveExtension("report.docx", ""), "docx");
  assert.equal(
    convert.resolveExtension("", "application/vnd.openxmlformats-officedocument.presentationml.presentation"),
    "pptx",
  );
  assert.equal(convert.resolveExtension("", "image/jpeg; charset=binary"), "jpg");
  assert.equal(convert.resolveExtension("", "application/octet-stream"), "");
});

await test("classifyExtension maps formats to engine families", () => {
  for (const ext of ["docx", "pptx", "xlsx", "odt", "rtf", "html"]) assert.equal(convert.classifyExtension(ext), "office", ext);
  for (const ext of ["jpg", "png", "webp", "gif", "tiff"]) assert.equal(convert.classifyExtension(ext), "image", ext);
  for (const ext of ["txt", "md", "csv", "json", "log"]) assert.equal(convert.classifyExtension(ext), "text", ext);
  assert.equal(convert.classifyExtension("pdf"), "pdf");
  assert.equal(convert.classifyExtension("exe"), null);
  assert.equal(convert.classifyExtension(""), null);
});

/* ═══════════════════════════ PDF writer ═══════════════════════════ */

await test("measureText grows with content and size", () => {
  assert.ok(writer.measureText("hello") > 0);
  assert.ok(writer.measureText("hello", 22) > writer.measureText("hello", 11));
  assert.ok(writer.measureText("wwww") > writer.measureText("iiii"));
});

await test("wrapText preserves breaks and bounds line width", () => {
  const max = 100;
  const lines = writer.wrapText("alpha beta gamma delta epsilon zeta", 11, max);
  assert.ok(lines.length > 1, "long text must wrap onto multiple lines");
  for (const line of lines) assert.ok(writer.measureText(line, 11) <= max + 0.01, `line too wide: "${line}"`);

  const kept = writer.wrapText("first\n\nsecond", 11, 500);
  assert.deepEqual(kept, ["first", "", "second"], "explicit blank lines are preserved");

  const hard = writer.wrapText("x".repeat(200), 11, 40);
  assert.ok(hard.length > 1, "a word longer than the line is hard-broken");
  for (const line of hard) assert.ok(writer.measureText(line, 11) <= 40 + 0.01);
});

await test("createTextPdf emits a structurally valid, paginated PDF", () => {
  const short = writer.createTextPdf("Hello PDF");
  const size = validatePdf(short);
  assert.ok(size >= 5, "catalog + pages + font + content + page");
  assert.ok(short.toString("latin1").includes("/BaseFont /Helvetica"));

  // Enough lines to force more than one page.
  const long = writer.createTextPdf(Array.from({ length: 400 }, (_, i) => `Line ${i}`).join("\n"));
  validatePdf(long);
  const count = long.toString("latin1").match(/\/Type \/Page[^s]/g) || [];
  assert.ok(count.length > 1, "long text must paginate");
});

await test("createTextPdf escapes parentheses and backslashes", () => {
  const buf = writer.createTextPdf("a (b) \\ c");
  validatePdf(buf);
  const text = buf.toString("latin1");
  assert.ok(text.includes("a \\(b\\) \\\\ c"), "literal strings must be escaped");
});

await test("createImagePdf embeds a JPEG via DCTDecode", async () => {
  const sharp = (await import("sharp")).default;
  const jpeg = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 30, b: 60 } } })
    .jpeg()
    .toBuffer();
  const pdf = writer.createImagePdf(jpeg, { width: 64, height: 48 });
  validatePdf(pdf);
  const text = pdf.toString("latin1");
  assert.ok(text.includes("/Subtype /Image"));
  assert.ok(text.includes("/Filter /DCTDecode"));
  assert.ok(text.includes("/Width 64 /Height 48"));
});

await test("createImagePdf rejects bad input", () => {
  assert.throws(() => writer.createImagePdf(Buffer.alloc(0), { width: 1, height: 1 }), /empty image/);
  assert.throws(() => writer.createImagePdf(Buffer.from("x"), {}), /dimensions required/);
});

/* ═══════════════════════════ converter ═══════════════════════════ */

await test("convertToPdf rejects empty buffers", async () => {
  await assert.rejects(() => convert.convertToPdf(Buffer.alloc(0)), /Empty file/);
});

await test("convertToPdf passes a PDF through untouched", async () => {
  const pdf = writer.createTextPdf("already");
  const out = await convert.convertToPdf(pdf, { fileName: "x.pdf", mimetype: "application/pdf" });
  assert.equal(out.engine, "passthrough");
  assert.equal(out.buffer, pdf, "same buffer, no re-encoding");
});

await test("convertToPdf renders text with the built-in writer", async () => {
  const out = await convert.convertToPdf(Buffer.from("hello world\nsecond line"), { fileName: "notes.txt" });
  assert.equal(out.engine, "builtin-text");
  validatePdf(out.buffer);
});

await test("convertToPdf renders images with the built-in writer", async () => {
  const sharp = (await import("sharp")).default;
  const png = await sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 10, g: 120, b: 200 } } })
    .png()
    .toBuffer();
  const out = await convert.convertToPdf(png, { fileName: "pic.png", mimetype: "image/png" });
  assert.equal(out.engine, "builtin-image");
  validatePdf(out.buffer);
});

await test("convertToPdf enforces the size limit", async () => {
  const prev = process.env.PDF_MAX_SIZE_MB;
  process.env.PDF_MAX_SIZE_MB = "1";
  try {
    const big = Buffer.alloc(2 * 1024 * 1024, 0x61);
    await assert.rejects(() => convert.convertToPdf(big, { fileName: "big.txt" }), /too large/i);
  } finally {
    if (prev === undefined) delete process.env.PDF_MAX_SIZE_MB;
    else process.env.PDF_MAX_SIZE_MB = prev;
  }
});

await test("convertToPdf explains office support when LibreOffice is absent", async () => {
  if (convert.isLibreOfficeAvailable()) {
    // LibreOffice is present — office files are handled for real (skip the assert).
    return;
  }
  await assert.rejects(
    () => convert.convertToPdf(Buffer.from("PK\u0003\u0004fake"), { fileName: "deck.pptx" }),
    /LibreOffice/,
  );
});

await test("convertToPdf rejects unknown formats with a helpful message", async () => {
  await assert.rejects(() => convert.convertToPdf(Buffer.from("MZ"), { fileName: "setup.exe" }), /not supported/i);
  await assert.rejects(() => convert.convertToPdf(Buffer.from("data"), { fileName: "", mimetype: "" }), /file type/i);
});

await test("supportedExtensions lists the accepted families", () => {
  const list = convert.supportedExtensions();
  assert.ok(list.office.includes("docx"));
  assert.ok(list.office.includes("pptx"));
  assert.ok(list.image.includes("png"));
  assert.ok(list.text.includes("txt"));
});

/* ═══════════════════════════ plugin registration ═══════════════════════════ */

await test(".pdf plugin registers with the expected metadata", async () => {
  const mod = await import("../plugins/utility/pdf.js");
  assert.equal(mod.config.name, "pdf");
  assert.equal(mod.config.category, "utility");
  assert.ok(mod.config.alias.includes("topdf"));
  assert.equal(typeof mod.handler, "function");
});

/* ═══════════════════════════ handler behaviour ═══════════════════════════ */

const plugin = await import("../plugins/utility/pdf.js");

/** Build a minimal `m` + `sock` pair for driving the command handler. */
function makeCtx({ quoted = null, self = {} } = {}) {
  const sent = [];
  const replies = [];
  const reactions = [];
  const sock = {
    sendMessage: async (jid, content, options) => {
      sent.push({ jid, content, options });
      return { key: { id: `m${sent.length}` } };
    },
  };
  const m = {
    chat: "1234@g.us",
    prefix: ".",
    raw: { key: { id: "RAW1" } },
    quoted,
    isDocument: false,
    isImage: false,
    reply: async (text) => {
      replies.push(text);
      return { key: { id: `r${replies.length}` } };
    },
    react: async (emoji) => {
      reactions.push(emoji);
      return null;
    },
    ...self,
  };
  return { m, sock, sent, replies, reactions, config: { command: { prefix: "." } } };
}

await test(".pdf with no attachment shows the usage card", async () => {
  const ctx = makeCtx();
  await plugin.handler(ctx.m, ctx);
  assert.equal(ctx.sent.length, 0, "must not send a document");
  assert.equal(ctx.replies.length, 1);
  assert.ok(ctx.replies[0].includes("PDF Converter"), ctx.replies[0]);
  assert.ok(/reply to a document/i.test(ctx.replies[0]), ctx.replies[0]);
});

await test(".pdf passes an already-PDF file through with a notice", async () => {
  const quoted = { isDocument: true, fileName: "report.pdf", mimetype: "application/pdf", download: async () => Buffer.from("x") };
  const ctx = makeCtx({ quoted });
  await plugin.handler(ctx.m, ctx);
  assert.equal(ctx.sent.length, 0, "must not re-send an existing PDF");
  assert.ok(/sudah berupa PDF/i.test(ctx.replies[0]), ctx.replies[0]);
});

await test(".pdf converts a replied text document and sends a PDF", async () => {
  const input = Buffer.from("hello world\nsecond line");
  const quoted = { isDocument: true, fileName: "notes.txt", mimetype: "text/plain", download: async () => input };
  const ctx = makeCtx({ quoted });
  await plugin.handler(ctx.m, ctx);

  assert.equal(ctx.sent.length, 1, "expected exactly one document send");
  const { content } = ctx.sent[0];
  assert.equal(content.mimetype, "application/pdf");
  assert.equal(content.fileName, "notes.pdf");
  assert.ok(Buffer.isBuffer(content.document));
  validatePdf(content.document);
  assert.deepEqual(ctx.reactions, ["🕕", "✅"]);
});

await test(".pdf converts a replied image and names the output from the source", async () => {
  const sharp = (await import("sharp")).default;
  const jpeg = await sharp({ create: { width: 32, height: 24, channels: 3, background: { r: 1, g: 2, b: 3 } } })
    .jpeg()
    .toBuffer();
  const quoted = { isImage: true, fileName: "photo.jpg", mimetype: "image/jpeg", download: async () => jpeg };
  const ctx = makeCtx({ quoted });
  await plugin.handler(ctx.m, ctx);

  assert.equal(ctx.sent.length, 1);
  assert.equal(ctx.sent[0].content.fileName, "photo.pdf");
  validatePdf(ctx.sent[0].content.document);
});

await test(".pdf uses the message itself when no reply carries a file", async () => {
  const ctx = makeCtx({ self: { isDocument: true, fileName: "self.csv", mimetype: "text/csv", download: async () => Buffer.from("a,b\n1,2") } });
  await plugin.handler(ctx.m, ctx);
  assert.equal(ctx.sent.length, 1, "the message's own document should convert");
  assert.equal(ctx.sent[0].content.fileName, "self.pdf");
});

await test(".pdf reports an unsupported format instead of sending", async () => {
  const quoted = { isDocument: true, fileName: "setup.exe", mimetype: "application/x-msdownload", download: async () => Buffer.from("MZ") };
  const ctx = makeCtx({ quoted });
  await plugin.handler(ctx.m, ctx);
  assert.equal(ctx.sent.length, 0);
  assert.ok(/not supported/i.test(ctx.replies[0]), ctx.replies[0]);
  assert.equal(ctx.reactions.at(-1), "☢");
});

await test(".pdf reports a failed download", async () => {
  const quoted = { isDocument: true, fileName: "notes.txt", mimetype: "text/plain", download: async () => null };
  const ctx = makeCtx({ quoted });
  await plugin.handler(ctx.m, ctx);
  assert.equal(ctx.sent.length, 0);
  assert.ok(/Gagal mengunduh/i.test(ctx.replies[0]), ctx.replies[0]);
  assert.equal(ctx.reactions.at(-1), "☢");
});

/* ─────────────────────────── report ─────────────────────────── */

for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name}${r.ok ? "" : ` — ${r.error}`}`);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} PDF checks passed`);
if (failed.length) process.exit(1);
process.exit(0);
