/**
 * Altheora — dynamic document scanner
 *
 * The whole point of the Altheora module is that NOTHING is hardcoded: every
 * category, folder and file is discovered by walking the filesystem on each
 * invocation. Adding/removing a folder or a document is therefore reflected
 * instantly, without a restart.
 *
 * Layout convention (all relative to `assets/altheora`):
 *
 *   assets/altheora/<Category Folder>/<document.pdf>
 *   assets/altheora/<Category Folder>/<Sub Folder>/<document.pdf>
 *
 * The folder name is the *display* name (original case / spaces / numbers are
 * preserved). A slugified, filesystem-order-independent *key* is used for the
 * interactive callback ids so that user input never has to be trusted as a
 * path.
 *
 * Security: every resolved path goes through `getSafePath()`, which refuses
 * anything that escapes the `assets/altheora` root (no `../`, no absolute
 * reads).
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";

/** Absolute path to the document root. Everything must stay inside this. */
export const ASSET_ROOT = path.resolve(process.cwd(), "assets", "altheora");

/** Extension → mimetype map. Extend here to support more formats. */
export const SUPPORTED_TYPES = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
};

/** Return the mimetype for a given extension, or null when unsupported. */
export function getMime(ext) {
  if (!ext) return null;
  return SUPPORTED_TYPES[String(ext).toLowerCase()] || null;
}

function shortHash(value) {
  return crypto.createHash("sha1").update(String(value)).digest("hex").slice(0, 6);
}

/**
 * Deterministic, URL/command safe slug. Keeps `[a-z0-9-]` only, so it is safe
 * to embed inside an interactive row id that is later re-parsed as a command.
 */
export function slugify(input) {
  const s = String(input ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "x";
}

/**
 * Display name of a document: the original filename with its extension
 * stripped, preserving case, spaces and punctuation.
 */
export function formatDisplayName(fileName) {
  const name = String(fileName ?? "");
  const ext = path.extname(name);
  return ext ? name.slice(0, -ext.length) : name;
}

function safeReadDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
}

function statSize(abs) {
  try {
    return fs.statSync(abs).size;
  } catch {
    return 0;
  }
}

/**
 * Resolve arbitrary segments under the document root, refusing anything that
 * escapes it. Returns an absolute path or `null` when unsafe.
 */
export function getSafePath(...segments) {
  try {
    const target = path.resolve(ASSET_ROOT, ...segments.map((s) => String(s)));
    const rel = path.relative(ASSET_ROOT, target);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
    return target;
  } catch {
    return null;
  }
}

/* ─────────────────────────── tree building ─────────────────────────── */

function buildChildren(absDir, relDir, usedKeys) {
  const entries = safeReadDir(absDir) || [];
  const dirs = entries
    .filter((e) => e.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name, "id"));
  const files = entries
    .filter((e) => e.isFile())
    .sort((a, b) => a.name.localeCompare(b.name, "id"));

  const children = [];

  const uniqueKey = (base, seed) => {
    let key = base;
    if (!key || usedKeys.has(key)) key = `${base || "x"}-${shortHash(seed)}`;
    let n = 2;
    while (usedKeys.has(key)) key = `${base}-${n++}`;
    usedKeys.add(key);
    return key;
  };

  for (const d of dirs) {
    const rel = relDir ? `${relDir}/${d.name}` : d.name;
    const key = uniqueKey(slugify(rel), rel);
    children.push({
      key,
      name: d.name,
      type: "dir",
      rel,
      children: buildChildren(path.join(absDir, d.name), rel, usedKeys),
    });
  }

  for (const f of files) {
    const rel = relDir ? `${relDir}/${f.name}` : f.name;
    const ext = path.extname(f.name).toLowerCase();
    const noExt = rel.slice(0, rel.length - path.extname(rel).length);
    const key = uniqueKey(slugify(noExt), rel);
    children.push({
      key,
      name: formatDisplayName(f.name),
      fileName: f.name,
      type: "file",
      rel,
      ext,
      mime: getMime(ext),
      supported: !!getMime(ext),
      size: statSize(path.join(absDir, f.name)),
    });
  }

  return children;
}

function countFiles(node) {
  if (!node) return 0;
  if (node.type === "file") return 1;
  return (node.children || []).reduce((acc, c) => acc + countFiles(c), 0);
}

/* ─────────────────────────── public scanners ─────────────────────────── */

/**
 * List every top-level folder as a category. Auto-refreshed on each call.
 * @returns {{ ok: boolean, error?: string, categories: Array }}
 */
export function scanCategories() {
  const entries = safeReadDir(ASSET_ROOT);
  if (entries === null) {
    return { ok: false, error: "missing-root", categories: [] };
  }

  const dirs = entries
    .filter((e) => e.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name, "id"));

  const used = new Set();
  const categories = [];

  for (const d of dirs) {
    const abs = path.join(ASSET_ROOT, d.name);
    let key = slugify(d.name);
    if (used.has(key)) key = `${key}-${shortHash(d.name)}`;
    while (used.has(key)) key = `${key}-x`;
    used.add(key);

    categories.push({
      key,
      name: d.name,
      rel: d.name,
      dir: abs,
      count: countFiles({ type: "dir", children: buildChildren(abs, "", new Set()) }),
    });
  }

  return { ok: true, categories };
}

/**
 * Build the recursive tree for a single category.
 * @returns {{ ok: boolean, error?: string, category?: object, tree?: object }}
 */
export function scanCategory(catKey) {
  const { ok, categories, error } = scanCategories();
  if (!ok) return { ok: false, error: error || "missing-root" };

  const category = categories.find((c) => c.key === catKey);
  if (!category) return { ok: false, error: "unknown-category" };

  const tree = {
    key: "-",
    name: category.name,
    type: "dir",
    rel: "",
    children: buildChildren(category.dir, "", new Set()),
  };

  return { ok: true, category, tree };
}

/** Depth-first lookup returning both the node and its parent (or null). */
export function findNode(root, key, parent = null) {
  if (!root) return null;
  if (root.key === key) return { node: root, parent };
  for (const child of root.children || []) {
    const found = findNode(child, key, root);
    if (found) return found;
  }
  return null;
}

/**
 * Resolve a (categoryKey, nodeKey) pair into a concrete, validated file.
 * The filesystem is re-scanned, so a deleted file simply stops resolving.
 *
 * @returns {{ ok: boolean, error?: string, node?: object, abs?: string, category?: object }}
 */
export function resolveFile(catKey, nodeKey) {
  const scan = scanCategory(catKey);
  if (!scan.ok) return { ok: false, error: scan.error };

  const found = findNode(scan.tree, nodeKey);
  if (!found || found.node.type !== "file") {
    return { ok: false, error: "not-found", category: scan.category };
  }

  const node = found.node;
  const segments = node.rel.split("/");
  const abs = getSafePath(scan.category.name, ...segments);
  if (!abs) return { ok: false, error: "unsafe", category: scan.category };
  if (!fs.existsSync(abs)) return { ok: false, error: "not-found", category: scan.category };

  return { ok: true, node, abs, category: scan.category };
}
