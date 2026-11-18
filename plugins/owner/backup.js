/**
 * GX-ID — /backup (owner only)
 *
 * Creates a FULL zip snapshot of the bot's own project directory and sends it.
 * Unlike /getsc (which is a safe source-only copy), this includes secrets and
 * runtime state: `.env`, `session/`, `database/`, `storage/`, `media/`, etc.
 * Only `node_modules` is skipped.
 *
 * Because the archive contains credentials and session keys, access is
 * restricted to the owner.
 */
import { existsSync, readdirSync, readFileSync } from "fs";
import { join, relative, sep } from "path";
import { deflateRawSync } from "zlib";

const pluginConfig = {
  name: "backup",
  alias: ["fullbackup", "backupall", "backupfull"],
  category: "owner",
  description: "Backup penuh proyek bot (database, .env, session, dll) kecuali node_modules",
  usage: ".backup",
  examples: [".backup"],
  permission: "owner",
  cooldown: 60,
  notes: "Berisi rahasia (session/.env) — hanya owner. node_modules dikecualikan.",
  isEnabled: true,
};

const EXCLUDED_DIRS = new Set(["node_modules"]);

function collectFiles(rootDir, current = rootDir, acc = []) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const full = join(current, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      collectFiles(rootDir, full, acc);
    } else if (entry.isFile()) {
      const rel = relative(rootDir, full);
      if (rel.startsWith("..") || rel.includes(`..${sep}`)) continue;
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

/** Build a ZIP buffer (deflate) from `{ rel, full }` entries. */
function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const data = readFileSync(entry.full);
    const nameBuf = Buffer.from(entry.rel, "utf8");
    const crc = crc32(data);
    const compressed = deflateRawSync(data);
    const useDeflate = compressed.length < data.length;
    const payload = useDeflate ? compressed : data;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, nameBuf, payload);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, nameBuf);

    offset += local.length + nameBuf.length + payload.length;
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

  await m.reply("📦 Menyiapkan backup penuh…");

  let entries;
  try {
    entries = collectFiles(root);
  } catch (error) {
    await m.reply("❌ Gagal membaca file proyek.");
    throw error;
  }

  if (!entries.length) return m.reply("❌ Tidak ada file untuk dibackup.");

  let zip;
  try {
    zip = buildZip(entries);
  } catch (error) {
    await m.reply("❌ Gagal membuat arsip backup.");
    throw error;
  }

  const name = `${(root.split(/[\\/]/).pop() || "bot")}-backup-${Date.now()}.zip`;
  await sock.sendMessage(
    m.chat,
    {
      document: zip,
      mimetype: "application/zip",
      fileName: name,
      caption: `📦 *Backup penuh* (${entries.length} file)\n\n> Termasuk .env, session, database & storage. Hanya node_modules yang dikecualikan.\n> ⚠️ Simpan arsip ini dengan aman — berisi kredensial.`,
    },
    { quoted: m.raw },
  );
}

export { pluginConfig as config, handler };
