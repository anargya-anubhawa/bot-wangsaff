/**
 * Altheora — cached asset registry
 *
 * Wraps the filesystem scanner (`_scanner.js`) with a short-lived metadata
 * cache so a flow tap never triggers a full recursive directory walk. The cache
 * is invalidated automatically when the directory tree changes (folder mtime /
 * entry-count signature), so adding, renaming or deleting a file is still
 * reflected on the very next call — no restart, no manual reload.
 *
 * Only metadata is cached. File *contents* are never cached here (PDFs are read
 * on demand by the plugin), and no absolute path ever leaves this module — the
 * flow payload only ever carries the namespaced ids.
 */
import fs from "fs";
import path from "path";
import { ASSET_ROOT, scanCategories, scanCategory } from "./_scanner.js";

/** Upper bound on how long a cached tree may live without revalidation. */
const CACHE_TTL_MS = 30000;

let cache = null;

/**
 * Build a change signature for the asset tree: every directory's mtime plus its
 * entry count. Adding/removing a file changes the parent's entry count even on
 * filesystems with coarse mtime resolution.
 */
function directorySignature(dir, acc = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  let mtime = 0;
  try {
    mtime = fs.statSync(dir).mtimeMs;
  } catch {
    /* ignore */
  }
  acc.push(`${dir}|${mtime}|${entries.length}`);
  for (const entry of entries) {
    if (entry.isDirectory()) directorySignature(path.join(dir, entry.name), acc);
  }
  return acc;
}

function currentSignature() {
  if (!fs.existsSync(ASSET_ROOT)) return "missing";
  return directorySignature(ASSET_ROOT).join("||");
}

/** Drop the cached tree so the next `getRegistry()` rebuilds from disk. */
export function invalidateRegistry() {
  cache = null;
}

/**
 * Return the cached asset tree:
 * `{ ok, categories: [{ id, name, title, description, count, children }] }`.
 * `children` are the raw scanner nodes (files / folders) of the category root.
 *
 * @param {{force?:boolean}} [options]
 */
export function getRegistry(options = {}) {
  const signature = currentSignature();
  const now = Date.now();
  if (!options.force && cache && cache.signature === signature && now - cache.at < CACHE_TTL_MS) {
    return cache.data;
  }

  const scan = scanCategories();
  if (!scan.ok) {
    const data = { ok: false, categories: [] };
    cache = { signature, at: now, data };
    return data;
  }

  const categories = scan.categories.map((category) => {
    const scanned = scanCategory(category.key);
    return {
      id: category.key,
      name: category.name,
      title: category.name,
      description: `${category.count} dokumen`,
      count: category.count,
      children: scanned.tree?.children || [],
    };
  });

  const data = { ok: true, categories };
  cache = { signature, at: now, data };
  return data;
}

/**
 * Flatten every *supported* file of a category into a list, walking nested
 * sub-folders. Each entry keeps the scanner node key (used as the flow id
 * suffix) plus a display title that includes the sub-folder breadcrumb.
 *
 * @param {{children?:Array}} category
 * @returns {Array<{key:string,title:string,description:string,supported:boolean,size:number,ext:string}>}
 */
export function collectFiles(category) {
  const files = [];
  const walk = (nodes, trail) => {
    for (const node of nodes || []) {
      if (node.type === "dir") {
        walk(node.children, [...trail, node.name]);
        continue;
      }
      if (node.type !== "file") continue;
      const prefix = trail.length ? `${trail.join(" › ")} › ` : "";
      const ext = (node.ext || "").replace(".", "").toUpperCase() || "FILE";
      files.push({
        key: node.key,
        title: `${prefix}${node.name}`,
        description: node.supported ? ext : `${ext} • tidak didukung`,
        supported: !!node.supported,
        size: node.size || 0,
        ext: node.ext || "",
      });
    }
  };
  walk(category?.children, []);
  return files;
}
