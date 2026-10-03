/**
 * GX-ID — /copy (owner)
 *
 * Creates a zip snapshot of the bot's own source tree and sends it. This is
 * deliberately narrow: it ONLY archives the project directory it runs in,
 * skips secrets/state (session, database, .env, node_modules, storage, media),
 * and never accepts a path argument — so it cannot be used to read arbitrary
 * filesystem locations.
 */
import { existsSync, readdirSync, readFileSync } from "fs";
import { join, relative, sep } from "path";

const pluginConfig = {
  name: "getsc",
  alias: ["copy", "sc", "sourcecode", "copysource", "backupsource"],
  category: "bot-config",
  description: "Kirim salinan kode sumber bot sebagai arsip (aman, tanpa rahasia)",
  usage: ".getsc",
  examples: [".getsc"],
  permission: "owner",
  cooldown: 30,
  notes: "Hanya mengarsipkan folder proyek bot; session/database/.env/node_modules dikecualikan.",
  isEnabled: true,
};

/** Directories that must never be archived (state, secrets, huge deps). */
const EXCLUDED_DIRS = new Set([
  "node_modules",
  ".git",
  "session",
  "sessions",
  "database",
  "storage",
  "media",
  "temp",
  "tmp",
  "assets",
  ".cache",
]);

/** Files that must never be archived (secrets / local state). */
const EXCLUDED_FILES = new Set([".env", ".env.local", ".env.production", "creds.json", "auth.json"]);
const EXCLUDED_EXT = new Set([".log", ".session", ".db", ".sqlite", ".sqlite3"]);

/**
 * Minimal ZIP writer (store + deflate) so we need no extra dependency.
 * Only paths relative to `rootDir` are ever written — no absolute paths, no
 * `..` traversal — which is what keeps this from becoming an arbitrary file
 * reader.
 */
function collectFiles(rootDir, current = rootDir, acc = []) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const full = join(current, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      collectFiles(rootDir, full, acc);
    } else if (entry.isFile()) {
      if (EXCLUDED_FILES.has(entry.name)) continue;
      const dot = entry.name.lastIndexOf(".");
      if (dot > -1 && EXCLUDED_EXT.has(entry.name.slice(dot).toLowerCase())) continue;
      const rel = relative(rootDir, full);
      if (rel.startsWith("..") || rel.includes(`..${sep}`)) continue; // safety
      acc.push({ full, rel: rel.split(sep).join("/") });
    }
  }
  return acc;
}

function crc32(buf) {
  let crc = ~0;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

/** Build a ZIP buffer from `{ rel, full }` entries. */
function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const data = readFileSync(entry.full);
    const nameBuf = Buffer.from(entry.rel, "utf8");
    const crc = crc32(data);
    const size = data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // store (no compression) — simple & dependency-free
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, nameBuf, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(size, 20);
    centralHeader.writeUInt32LE(size, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuf, end]);
}

async function handler(m, { sock }) {
  const root = process.cwd();
  if (!existsSync(root)) return m.reply("❌ Direktori proyek tidak ditemukan.");

  await m.reply("📦 Menyiapkan salinan sumber…");

  let entries;
  try {
    entries = collectFiles(root);
  } catch (error) {
    await m.reply("❌ Gagal membaca file sumber.");
    throw error;
  }

  if (!entries.length) return m.reply("❌ Tidak ada file sumber untuk disalin.");

  let zip;
  try {
    zip = buildZip(entries);
  } catch (error) {
    await m.reply("❌ Gagal membuat arsip.");
    throw error;
  }

  const name = `${(process.cwd().split(/[\\/]/).pop() || "bot")}-source-${Date.now()}.zip`;
  await sock.sendMessage(
    m.chat,
    {
      document: zip,
      mimetype: "application/zip",
      fileName: name,
      caption: `📦 *Salinan sumber* (${entries.length} file)\n\n> Rahasia & state (session/database/.env/node_modules) dikecualikan.`,
    },
    { quoted: m.raw },
  );
}

export { pluginConfig as config, handler };
