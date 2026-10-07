/**
 * GX-ID — minimal PDF text extractor
 *
 * The inverse of `lib/pdf-writer.js`: it pulls the text out of a PDF with **no**
 * external tool and no third-party package, so `pdf → docx/txt/md/html/rtf`
 * works on any host.
 *
 * How it works:
 *   1. Every `N 0 obj … endobj` in the file is collected by scanning the raw
 *      bytes (no xref parsing needed — that also tolerates slightly broken
 *      files).
 *   2. Objects packed inside a `/Type /ObjStm` (compressed object stream) are
 *      inflated and merged in, so modern PDFs are covered too.
 *   3. The page tree is walked from the catalog to get the pages **in order**,
 *      falling back to a numeric sort when the tree is unreadable.
 *   4. Each page's content stream is decoded (`FlateDecode` / `ASCIIHexDecode`)
 *      and its text-showing operators (`Tj`, `TJ`, `'`, `"`) are replayed into
 *      lines, using the positioning operators (`Td`, `TD`, `Tm`, `T*`) to decide
 *      where the line breaks go.
 *
 * Scope & honesty: this is a *text* extractor for ordinary (born-digital)
 * PDFs. It does not OCR scanned pages, does not render images, and cannot map
 * exotic CID/`Type0` fonts back to Unicode — those pages yield little or no
 * text, and `extractPdfText()` reports that through `pagesWithText` so callers
 * can tell the user instead of sending an empty file.
 */
import zlib from "zlib";

/* ─────────────────────────────── low-level ─────────────────────────────── */

const WHITESPACE = new Set([" ", "\n", "\r", "\t", "\f", "\0"]);
const DELIMITERS = new Set(["(", ")", "<", ">", "[", "]", "{", "}", "/", "%"]);

function isSpace(ch) {
  return WHITESPACE.has(ch);
}
function isDelim(ch) {
  return DELIMITERS.has(ch) || WHITESPACE.has(ch);
}

/** Inflate a stream payload, tolerating raw-deflate and stored data. */
function inflate(buf) {
  if (!buf || !buf.length) return null;
  try {
    return zlib.inflateSync(buf);
  } catch {
    /* not zlib-wrapped */
  }
  try {
    return zlib.inflateRawSync(buf);
  } catch {
    /* not raw deflate */
  }
  return null;
}

/** Decode `ASCIIHexDecode` data into bytes. */
function asciiHexDecode(buf) {
  const hex = buf.toString("latin1").replace(/[^0-9a-fA-F]/g, "");
  const even = hex.length % 2 ? `${hex}0` : hex;
  const out = Buffer.alloc(even.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(even.substr(i * 2, 2), 16);
  return out;
}

/**
 * Extract the raw (still-encoded) stream bytes from an object body.
 * Returns `null` when the object carries no stream.
 */
function rawStream(body) {
  const idx = body.indexOf("stream");
  if (idx === -1) return null;
  // Guard against matching the "stream" inside e.g. "/Subtype" — the keyword
  // must be preceded by a delimiter or start of body.
  const before = idx > 0 ? body[idx - 1] : " ";
  if (!isDelim(before)) return null;

  let start = idx + "stream".length;
  if (body[start] === "\r") start++;
  if (body[start] === "\n") start++;

  const end = body.indexOf("endstream", start);
  if (end === -1) return null;
  return Buffer.from(body.slice(start, end), "latin1");
}

/** Decode a stream according to its `/Filter`, returning bytes or `null`. */
function decodeStream(body) {
  const raw = rawStream(body);
  if (!raw) return null;

  const filterMatch = body.match(/\/Filter\s*(\[[^\]]*\]|\/\w+)/);
  const filters = filterMatch
    ? [...filterMatch[1].matchAll(/\/(\w+)/g)].map((m) => m[1])
    : [];

  let data = raw;
  for (const filter of filters) {
    if (filter === "FlateDecode" || filter === "Fl") {
      data = inflate(data);
      if (!data) return null;
    } else if (filter === "ASCIIHexDecode" || filter === "AHx") {
      data = asciiHexDecode(data);
    } else if (filter === "ASCII85Decode" || filter === "A85") {
      return null; // rare for content streams; not supported
    }
    // DCTDecode / JPXDecode / CCITTFaxDecode are images — not text.
    else if (filter !== "Crypt") {
      return null;
    }
  }
  return data;
}

/* ─────────────────────────────── objects ─────────────────────────────── */

/** Slice one object body starting right after `N G obj`. */
function sliceObject(text, start) {
  const streamIdx = text.indexOf("stream", start);
  const endobjIdx = text.indexOf("endobj", start);
  if (streamIdx !== -1 && (endobjIdx === -1 || streamIdx < endobjIdx)) {
    const es = text.indexOf("endstream", streamIdx);
    if (es !== -1) {
      const eo = text.indexOf("endobj", es);
      if (eo !== -1) return text.slice(start, eo);
    }
  }
  if (endobjIdx === -1) return text.slice(start, Math.min(text.length, start + 5_000_000));
  return text.slice(start, endobjIdx);
}

/** Collect every top-level object by scanning for `N G obj`. */
function collectObjects(buf) {
  const text = buf.toString("latin1");
  const map = new Map(); // num → body string
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = re.exec(text))) {
    const num = Number(m[1]);
    if (map.has(num)) continue;
    map.set(num, sliceObject(text, m.index + m[0].length));
  }
  return map;
}

/** Merge the objects packed inside `/Type /ObjStm` streams into `map`. */
function mergeObjectStreams(map) {
  const additions = [];
  for (const body of [...map.values()]) {
    if (!/\/Type\s*\/ObjStm/.test(body)) continue;
    const data = decodeStream(body);
    if (!data) continue;

    const first = Number((body.match(/\/First\s+(\d+)/) || [])[1]);
    if (!Number.isFinite(first) || first <= 0) continue;

    const text = data.toString("latin1");
    const header = text.slice(0, first).trim().split(/\s+/).map(Number).filter(Number.isFinite);
    const pairs = [];
    for (let i = 0; i + 1 < header.length; i += 2) pairs.push({ num: header[i], offset: header[i + 1] });

    for (let i = 0; i < pairs.length; i++) {
      const start = first + pairs[i].offset;
      const end = i + 1 < pairs.length ? first + pairs[i + 1].offset : text.length;
      if (!map.has(pairs[i].num)) additions.push([pairs[i].num, text.slice(start, end)]);
    }
  }
  for (const [num, body] of additions) map.set(num, body);
}

/* ─────────────────────────────── pages ─────────────────────────────── */

/** Walk the page tree from the catalog, returning page object numbers in order. */
function findPageOrder(map) {
  let root = null;
  for (const body of map.values()) {
    if (/\/Type\s*\/Catalog/.test(body)) {
      const m = body.match(/\/Pages\s+(\d+)\s+\d+\s+R/);
      if (m) {
        root = Number(m[1]);
        break;
      }
    }
  }

  const order = [];
  const seen = new Set();
  const isPage = (b) => /\/Type\s*\/Page\b/.test(b) && !/\/Type\s*\/Pages/.test(b);

  const walk = (num, depth) => {
    if (depth > 128 || seen.has(num)) return;
    seen.add(num);
    const body = map.get(num);
    if (!body) return;
    if (isPage(body)) {
      order.push(num);
      return;
    }
    const kids = body.match(/\/Kids\s*\[([^\]]*)\]/);
    if (kids) {
      for (const ref of kids[1].matchAll(/(\d+)\s+\d+\s+R/g)) walk(Number(ref[1]), depth + 1);
    }
  };

  if (root !== null) walk(root, 0);

  if (!order.length) {
    for (const [num, body] of map) if (isPage(body)) order.push(num);
    order.sort((a, b) => a - b);
  }
  return order;
}

/** Concatenate and decode every content stream referenced by a page. */
function pageContent(pageBody, map) {
  const refs = [];
  const array = pageBody.match(/\/Contents\s*\[([^\]]*)\]/);
  if (array) {
    for (const r of array[1].matchAll(/(\d+)\s+\d+\s+R/g)) refs.push(Number(r[1]));
  } else {
    const single = pageBody.match(/\/Contents\s+(\d+)\s+\d+\s+R/);
    if (single) refs.push(Number(single[1]));
  }

  const parts = [];
  for (const num of refs) {
    const body = map.get(num);
    if (!body) continue;
    const data = decodeStream(body);
    if (data) parts.push(data.toString("latin1"));
  }
  return parts.join("\n");
}

/* ─────────────────────────── text extraction ─────────────────────────── */

/** Read a `( … )` literal string starting at `i`; returns bytes + next index. */
function readLiteralString(content, i) {
  const bytes = [];
  let depth = 1;
  let j = i + 1;
  while (j < content.length && depth > 0) {
    const ch = content[j];
    if (ch === "\\") {
      const next = content[j + 1];
      const simple = { n: 10, r: 13, t: 9, b: 8, f: 12, "(": 40, ")": 41, "\\": 92 };
      if (next in simple) {
        bytes.push(simple[next]);
        j += 2;
        continue;
      }
      if (next >= "0" && next <= "7") {
        let oct = "";
        let k = j + 1;
        while (k < content.length && oct.length < 3 && content[k] >= "0" && content[k] <= "7") {
          oct += content[k];
          k++;
        }
        bytes.push(Number.parseInt(oct, 8) & 0xff);
        j = k;
        continue;
      }
      if (next === "\n") {
        j += 2;
        continue;
      }
      if (next === "\r") {
        j += content[j + 2] === "\n" ? 3 : 2;
        continue;
      }
      bytes.push(content.charCodeAt(j + 1) & 0xff);
      j += 2;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) {
        j++;
        break;
      }
    }
    bytes.push(ch.charCodeAt(0) & 0xff);
    j++;
  }
  return { bytes: Buffer.from(bytes), next: j };
}

/** Read a `< … >` hex string starting at `i`; returns bytes + next index. */
function readHexString(content, i) {
  const end = content.indexOf(">", i + 1);
  const slice = end === -1 ? content.slice(i + 1) : content.slice(i + 1, end);
  return { bytes: asciiHexDecode(Buffer.from(slice, "latin1")), next: end === -1 ? content.length : end + 1 };
}

/** Decode PDF string bytes to text (UTF-16BE when BOM-prefixed, else Latin-1). */
function decodePdfString(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return bytes.subarray(2).toString("utf16le").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
  }
  return bytes.toString("latin1");
}

/** Split a content stream into `{type,value}` tokens. */
function tokenize(content) {
  const tokens = [];
  let i = 0;
  const n = content.length;
  while (i < n) {
    const ch = content[i];
    if (ch === "%") {
      while (i < n && content[i] !== "\n" && content[i] !== "\r") i++;
      continue;
    }
    if (isSpace(ch)) {
      i++;
      continue;
    }
    if (ch === "(") {
      const { bytes, next } = readLiteralString(content, i);
      tokens.push({ type: "str", value: decodePdfString(bytes) });
      i = next;
      continue;
    }
    if (ch === "<" && content[i + 1] === "<") {
      // Skip a dictionary literal (balanced).
      let depth = 0;
      let j = i;
      while (j < n) {
        if (content[j] === "<" && content[j + 1] === "<") {
          depth++;
          j += 2;
          continue;
        }
        if (content[j] === ">" && content[j + 1] === ">") {
          depth--;
          j += 2;
          if (depth === 0) break;
          continue;
        }
        j++;
      }
      tokens.push({ type: "op", value: "<<" });
      i = j;
      continue;
    }
    if (ch === "<") {
      const { bytes, next } = readHexString(content, i);
      tokens.push({ type: "str", value: decodePdfString(bytes) });
      i = next;
      continue;
    }
    if (ch === "[") {
      tokens.push({ type: "arrStart" });
      i++;
      continue;
    }
    if (ch === "]") {
      tokens.push({ type: "arrEnd" });
      i++;
      continue;
    }
    if (ch === "{" || ch === "}") {
      i++;
      continue;
    }
    if (ch === "/") {
      let j = i + 1;
      while (j < n && !isDelim(content[j])) j++;
      tokens.push({ type: "name", value: content.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9+\-.]/.test(ch)) {
      let j = i;
      while (j < n && /[0-9+\-.]/.test(content[j])) j++;
      const value = Number(content.slice(i, j));
      tokens.push({ type: "num", value: Number.isFinite(value) ? value : 0 });
      i = j;
      continue;
    }
    let j = i;
    while (j < n && !isDelim(content[j])) j++;
    tokens.push({ type: "op", value: content.slice(i, j) });
    i = j;
  }
  return tokens;
}

/**
 * Replay a page's content stream and return its lines of text.
 *
 * The heuristic for line breaks: `T*` always breaks; `Td`/`TD` break when the
 * vertical component is non-zero; `Tm` breaks when the `f` (vertical) term
 * changes. Horizontal `Tm` moves become a single space. `TJ` gaps wider than a
 * quarter em also become a space.
 */
function contentToLines(content) {
  const tokens = tokenize(content);
  const lines = [];
  let cur = "";
  let pending = false; // a text-showing op occurred since the last flush
  let lastY = null;
  let lastX = null;
  const operands = [];
  let array = null;

  const flush = () => {
    lines.push(cur);
    cur = "";
    pending = false;
  };
  const put = (s) => {
    cur += s;
    pending = true;
  };
  const numAt = (idx) => {
    const t = operands[idx];
    return t && t.type === "num" ? t.value : 0;
  };

  for (const t of tokens) {
    if (t.type === "arrStart") {
      array = [];
      continue;
    }
    if (t.type === "arrEnd") {
      if (array) operands.push({ type: "arr", value: array });
      array = null;
      continue;
    }
    if (array) {
      if (t.type === "str" || t.type === "num") array.push(t);
      continue;
    }
    if (t.type !== "op") {
      operands.push(t);
      continue;
    }

    const op = t.value;
    const last = operands[operands.length - 1];

    switch (op) {
      case "Tj":
        if (last && last.type === "str") put(last.value);
        else pending = true;
        break;
      case "TJ": {
        const arr = operands.find((o) => o.type === "arr");
        if (arr) {
          pending = true;
          for (const item of arr.value) {
            if (item.type === "str") cur += item.value;
            else if (item.type === "num" && item.value <= -120) cur += " ";
          }
        }
        break;
      }
      case "'":
      case '"':
        if (pending) flush();
        if (last && last.type === "str") put(last.value);
        else pending = true;
        break;
      case "T*":
        if (pending) flush();
        break;
      case "Td":
      case "TD": {
        const ty = numAt(operands.length - 1);
        if (Math.abs(ty) > 0.01 && pending) flush();
        break;
      }
      case "Tm": {
        const f = numAt(operands.length - 1);
        const e = numAt(operands.length - 2);
        if (lastY !== null && Math.abs(f - lastY) > 0.5) {
          if (pending) flush();
        } else if (lastX !== null && e - lastX > 1 && cur && !cur.endsWith(" ")) {
          cur += " ";
        }
        lastY = f;
        lastX = e;
        break;
      }
      case "BT":
        lastY = null;
        lastX = null;
        break;
      default:
        break;
    }

    operands.length = 0;
  }

  if (pending) flush();
  return lines;
}

/* ─────────────────────────────── public API ─────────────────────────────── */

/**
 * Extract the text of a PDF.
 *
 * @param {Buffer} buffer
 * @returns {{ok:boolean, error?:string, encrypted?:boolean, pages:string[],
 *            pageCount:number, pagesWithText:number, text:string}}
 */
export function extractPdfText(buffer) {
  const empty = { ok: false, pages: [], pageCount: 0, pagesWithText: 0, text: "" };

  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { ...empty, error: "Empty file" };
  }
  if (buffer.subarray(0, 5).toString("latin1") !== "%PDF-") {
    return { ...empty, error: "Bukan file PDF yang valid." };
  }

  const map = collectObjects(buffer);
  if (map.size === 0) return { ...empty, error: "Struktur PDF tidak terbaca." };

  if ([...map.values()].some((b) => /\/Type\s*\/Encrypt/.test(b) || /\/Encrypt\s+\d+\s+\d+\s+R/.test(b))) {
    return { ...empty, encrypted: true, error: "PDF ini terenkripsi dan tidak bisa dibaca." };
  }

  mergeObjectStreams(map);

  const order = findPageOrder(map);
  const pages = [];

  for (const num of order) {
    const body = map.get(num);
    if (!body) continue;
    const content = pageContent(body, map);
    const lines = content ? contentToLines(content) : [];
    // Drop the trailing empty line the writer emits after the last flush.
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    pages.push(lines.join("\n"));
  }

  // Fallback: no page tree but content streams exist — treat each as a page.
  if (!pages.length) {
    for (const body of map.values()) {
      if (!/\/Length\s+\d+/.test(body) || !/stream/.test(body)) continue;
      if (/\/Type\s*\/(ObjStm|XRef|Metadata|XObject)/.test(body)) continue;
      const data = decodeStream(body);
      if (!data) continue;
      const lines = contentToLines(data.toString("latin1"));
      if (lines.join("").trim()) pages.push(lines.join("\n"));
    }
  }

  const text = pages.join("\n\n").replace(/\u0000/g, "").trim();
  const pagesWithText = pages.filter((p) => p.trim()).length;

  return { ok: true, pages, pageCount: pages.length, pagesWithText, text };
}
