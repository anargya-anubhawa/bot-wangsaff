/**
 * VEA — /backup (owner only)
 *
 *   .backup                 → inspect what will be archived (structure + sizes)
 *   .backup start           → build the archive and deliver it per settings
 *   .backup setting         → native-flow menu (delivery + scope)
 *   .backup whatsapp|hosting|full|source → quick setters
 *
 * Two scopes:
 *   full   — the whole project except `node_modules` (secrets + state included)
 *   source — same exclusions as /getsc (no .env, session, database, ...)
 *
 * Two deliveries:
 *   whatsapp — send one ZIP document
 *   hosting  — upload to catbox.moe (no login) and send the link; falls back to
 *              litterbox (72h) when the file is over catbox's 200 MB limit.
 */
import { existsSync } from "fs";
import { readdir, readFile, stat } from "fs/promises";
import { join, relative, sep } from "path";
import { deflateRaw } from "zlib";
import { promisify } from "util";
import { formatFileSize } from "../../lib/formatter.js";
import { registerFlowRoute } from "../../lib/flow-router.js";
import { sendNativeFlow, createSingleSelect, buildMessageParams } from "../../lib/flow.js";
import { isOwnerOrWhitelistedIn } from "../../lib/access.js";
import {
  getBackupDelivery,
  setBackupDelivery,
  getBackupScope,
  setBackupScope,
  BACKUP_DELIVERY,
  BACKUP_SCOPE,
} from "../../lib/settings.js";

const deflate = promisify(deflateRaw);

const pluginConfig = {
  name: "backup",
  alias: ["fullbackup", "backupall", "backupfull"],
  category: "owner",
  description: "Backup proyek bot (full / source) ke WhatsApp atau hosting gratis",
  usage: ".backup [start|setting]",
  examples: [".backup", ".backup start", ".backup setting"],
  permission: "owner",
  cooldown: 60,
  notes: "Default full backup termasuk .env/session/database. Hanya owner.",
  isEnabled: true,
};

const EXCLUDED_DIRS = {
  [BACKUP_SCOPE.FULL]: new Set(["node_modules"]),
  [BACKUP_SCOPE.SOURCE]: new Set([
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
  ]),
};

const SOURCE_EXCLUDED_FILES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  "creds.json",
  "auth.json",
]);

const SOURCE_EXCLUDED_EXT = new Set([".log", ".session", ".db", ".sqlite", ".sqlite3"]);

const CATBOX_LIMIT = 200 * 1024 * 1024;

/* ─────────────────────────── file collection ─────────────────────────── */

function isExcludedFile(name) {
  return SOURCE_EXCLUDED_FILES.has(name);
}

function isExcludedByExt(name) {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  return SOURCE_EXCLUDED_EXT.has(name.slice(dot).toLowerCase());
}

async function collectFiles(rootDir, scope, current = rootDir, acc = []) {
  const excludedDirs = EXCLUDED_DIRS[scope] || EXCLUDED_DIRS[BACKUP_SCOPE.FULL];
  const sourceMode = scope === BACKUP_SCOPE.SOURCE;

  for (const entry of await readdir(current, { withFileTypes: true })) {
    const full = join(current, entry.name);
    if (entry.isDirectory()) {
      if (excludedDirs.has(entry.name)) continue;
      await collectFiles(rootDir, scope, full, acc);
    } else if (entry.isFile()) {
      if (sourceMode && (isExcludedFile(entry.name) || isExcludedByExt(entry.name))) continue;
      const rel = relative(rootDir, full);
      if (rel.startsWith("..") || rel.includes(`..${sep}`)) continue;
      acc.push({ full, rel: rel.split(sep).join("/") });
    }
  }
  return acc;
}

async function summarize(entries) {
  const groups = new Map();
  let totalBytes = 0;

  for (const entry of entries) {
    let size = 0;
    try {
      size = (await stat(entry.full)).size;
    } catch {
      size = 0;
    }
    totalBytes += size;

    const parts = entry.rel.split("/");
    const key = parts.length > 1 ? `${parts[0]}/` : parts[0];
    const group = groups.get(key) || { key, files: 0, bytes: 0 };
    group.files += 1;
    group.bytes += size;
    groups.set(key, group);
  }

  return {
    totalBytes,
    totalFiles: entries.length,
    groups: [...groups.values()].sort((a, b) => b.bytes - a.bytes),
  };
}

/* ─────────────────────────── zip writer ─────────────────────────── */

function crc32(buf) {
  let crc = ~0;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

async function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const data = await readFile(entry.full);
    const nameBuf = Buffer.from(entry.rel, "utf8");
    const crc = crc32(data);

    let payload = data;
    let method = 0;
    try {
      const compressed = await deflate(data);
      if (compressed.length < data.length) {
        payload = compressed;
        method = 8;
      }
    } catch {
      /* fall back to store */
    }

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

/* ─────────────────────────── delivery ─────────────────────────── */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function sendDocument(sock, m, buffer, fileName, caption) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await sock.sendMessage(
        m.chat,
        { document: buffer, mimetype: "application/zip", fileName, caption },
        { quoted: m.raw },
      );
      return;
    } catch (error) {
      if (attempt === 3) throw error;
      await sleep(8000);
    }
  }
}

async function postMultipart(url, fields, blob, fileName) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  form.append("fileToUpload", blob, fileName);
  const response = await fetch(url, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(300_000),
  });
  const text = (await response.text()).trim();
  if (!response.ok || !/^https?:\/\//i.test(text)) {
    throw new Error(`hosting HTTP ${response.status}: ${text.slice(0, 120) || "no url"}`);
  }
  return text;
}

async function uploadArchive(zip, fileName) {
  const blob = new Blob([zip], { type: "application/zip" });
  const tooBig = zip.length > CATBOX_LIMIT;

  if (!tooBig) {
    try {
      const url = await postMultipart(
        "https://catbox.moe/user/api.php",
        { reqtype: "fileupload" },
        blob,
        fileName,
      );
      return { url, host: "catbox.moe", expiry: null };
    } catch {
      /* fall through to litterbox */
    }
  }

  const url = await postMultipart(
    "https://litterbox.catbox.moe/resources/internals/api.php",
    { reqtype: "fileupload", time: "72h" },
    blob,
    fileName,
  );
  return { url, host: "litterbox.catbox.moe", expiry: "72 jam" };
}

/* ─────────────────────────── views ─────────────────────────── */

function scopeLabel(scope) {
  return scope === BACKUP_SCOPE.SOURCE ? "Source only (.getsc)" : "Full backup";
}

function deliveryLabel(delivery) {
  return delivery === BACKUP_DELIVERY.HOSTING ? "Hosting gratis (link)" : "WhatsApp (dokumen)";
}

async function showInspection(m, ctx) {
  const root = process.cwd();
  if (!existsSync(root)) return m.reply("❌ Direktori proyek tidak ditemukan.");

  const scope = getBackupScope();
  let entries;
  try {
    entries = await collectFiles(root, scope);
  } catch (error) {
    await m.reply("❌ Gagal membaca file proyek.");
    throw error;
  }

  if (!entries.length) return m.reply("❌ Tidak ada file untuk dibackup.");

  const { totalBytes, totalFiles, groups } = await summarize(entries);
  const max = 25;
  const shown = groups.slice(0, max);
  const structure = shown
    .map((g) => `┃ ${g.key} — ${g.files} file · ${formatFileSize(g.bytes)}`)
    .join("\n");
  const more = groups.length > max ? `\n┃ … dan ${groups.length - max} item lainnya` : "";

  const excluded =
    scope === BACKUP_SCOPE.SOURCE
      ? "node_modules, .env, session, database, storage, media, assets, .git"
      : "node_modules";

  await m.reply(
    `📦 *Backup — Pemeriksaan Data*\n\n` +
      `> Mode    : *${scopeLabel(scope)}*\n` +
      `> Kirim   : *${deliveryLabel(getBackupDelivery())}*\n` +
      `> Dikecualikan: ${excluded}\n\n` +
      `*Total:* ${totalFiles} file · ${formatFileSize(totalBytes)}\n\n` +
      `*Struktur:*\n${structure}${more}\n\n` +
      `> Jalankan \`${m.prefix || "."}backup start\` untuk mulai.\n` +
      `> Ubah opsi: \`${m.prefix || "."}backup setting\`.`,
  );
}

function settingsButtons() {
  const delivery = getBackupDelivery();
  const scope = getBackupScope();

  return [
    createSingleSelect({
      title: "Pengiriman",
      sectionTitle: "CARA KIRIM",
      highlightLabel: "Pilih pengiriman",
      rows: [
        {
          id: "backup:delivery:whatsapp",
          title: "WhatsApp (dokumen)",
          description: delivery === BACKUP_DELIVERY.WHATSAPP ? "Aktif — kirim ZIP ke chat" : "Kirim ZIP langsung",
        },
        {
          id: "backup:delivery:hosting",
          title: "Hosting gratis (link)",
          description: delivery === BACKUP_DELIVERY.HOSTING ? "Aktif — upload & kirim link" : "Upload tanpa login",
        },
      ],
    }),
    createSingleSelect({
      title: "Cakupan",
      sectionTitle: "ISI BACKUP",
      highlightLabel: "Pilih cakupan",
      rows: [
        {
          id: "backup:scope:full",
          title: "Full backup",
          description: scope === BACKUP_SCOPE.FULL ? "Aktif — semua kecuali node_modules" : "Database, .env, session",
        },
        {
          id: "backup:scope:source",
          title: "Source only (.getsc)",
          description: scope === BACKUP_SCOPE.SOURCE ? "Aktif — kode sumber saja" : "Tanpa rahasia & state",
        },
      ],
    }),
  ];
}

async function showSettings(m, ctx, note = "") {
  const prefix = m.prefix || ".";
  const body =
    `⚙️ *Backup Settings*\n\n` +
    (note ? `${note}\n\n` : "") +
    `> Pengiriman : *${deliveryLabel(getBackupDelivery())}*\n` +
    `> Cakupan    : *${scopeLabel(getBackupScope())}*\n\n` +
    `Pilih opsi di bawah. Perubahan langsung tersimpan.\n` +
    `Mulai: \`${prefix}backup start\` · Cek data: \`${prefix}backup\``;

  const ok = await sendNativeFlow(ctx.sock, m.chat, {
    headerTitle: "Backup Settings",
    body,
    footer: "VEA • Backup",
    buttons: settingsButtons(),
    messageParamsJson: buildMessageParams({ listTitle: "BACKUP", buttonTitle: "PILIH" }),
    quoted: m.raw,
    mentionedJid: [m.sender],
    fallbackLabel: "backup-settings",
  });

  if (!ok) {
    await m.reply(
      `${body}\n\n*Fallback teks:*\n` +
        `> \`${prefix}backup whatsapp\` / \`${prefix}backup hosting\`\n` +
        `> \`${prefix}backup full\` / \`${prefix}backup source\``,
    );
  }
  return true;
}

/* ─────────────────────────── actions ─────────────────────────── */

async function startBackup(m, ctx) {
  const root = process.cwd();
  if (!existsSync(root)) return m.reply("❌ Direktori proyek tidak ditemukan.");

  const scope = getBackupScope();
  const delivery = getBackupDelivery();

  await m.reply(`📦 Menyiapkan ${scopeLabel(scope).toLowerCase()}…`);

  let entries;
  try {
    entries = await collectFiles(root, scope);
  } catch (error) {
    await m.reply("❌ Gagal membaca file proyek.");
    throw error;
  }
  if (!entries.length) return m.reply("❌ Tidak ada file untuk dibackup.");

  let zip;
  try {
    zip = await buildZip(entries);
  } catch (error) {
    await m.reply("❌ Gagal membuat arsip backup.");
    throw error;
  }

  const base = `${root.split(/[\\/]/).pop() || "bot"}-backup-${Date.now()}`;
  const size = formatFileSize(zip.length);

  if (delivery === BACKUP_DELIVERY.HOSTING) {
    await m.reply(`☁️ Mengunggah ${size} ke cloud…`);
    let uploaded;
    try {
      uploaded = await uploadArchive(zip, `${base}.zip`);
    } catch (error) {
      await m.reply(
        `❌ *Upload gagal.*\n\n> ${error.message}\n\n` +
          `> Coba lagi atau set pengiriman ke WhatsApp:\n> \`${m.prefix || "."}backup whatsapp\``,
      );
      throw error;
    }

    await m.reply(
      `✅ *Backup selesai*\n\n` +
        `> File    : *${base}.zip*\n` +
        `> Ukuran  : *${size}*\n` +
        `> Mode    : *${scopeLabel(scope)}*\n` +
        `> Host    : *${uploaded.host}*${uploaded.expiry ? ` (${uploaded.expiry})` : ""}\n` +
        `> File    : ${entries.length} file\n\n` +
        `🔗 ${uploaded.url}`,
    );
    return;
  }

  await sendDocument(
    ctx.sock,
    m,
    zip,
    `${base}.zip`,
    `📦 *Backup* (${scopeLabel(scope)})\n\n` +
      `> ${entries.length} file · ${size}\n` +
      (scope === BACKUP_SCOPE.FULL
        ? "> Termasuk .env, session, database & storage. Simpan dengan aman."
        : "> Mode source: rahasia & state dikecualikan."),
  );
}

/* ─────────────────────────── flow route ─────────────────────────── */

registerFlowRoute("backup", async (m, ctx, { action, args }) => {
  if (!isOwnerOrWhitelistedIn(m)) {
    await m.reply("❌ *Akses ditolak.*\n\n> Backup hanya untuk owner.").catch(() => {});
    return true;
  }

  const value = String(args[0] || "").toLowerCase();

  if (action === "delivery") {
    if (!setBackupDelivery(value)) return false;
    return showSettings(m, ctx, `✅ Pengiriman: *${deliveryLabel(getBackupDelivery())}*`);
  }
  if (action === "scope") {
    if (!setBackupScope(value)) return false;
    return showSettings(m, ctx, `✅ Cakupan: *${scopeLabel(getBackupScope())}*`);
  }
  if (action === "menu") return showSettings(m, ctx);
  if (action === "start") return startBackup(m, ctx);
  return false;
});

/* ─────────────────────────── handler ─────────────────────────── */

async function handler(m, ctx) {
  const sub = String(m.args?.[0] || "").toLowerCase();
  const prefix = m.prefix || ".";

  switch (sub) {
    case "":
    case "check":
    case "info":
    case "status":
      return showInspection(m, ctx);
    case "start":
    case "run":
    case "go":
      return startBackup(m, ctx);
    case "setting":
    case "settings":
    case "set":
      return showSettings(m, ctx);
    case "whatsapp":
    case "wa":
      setBackupDelivery(BACKUP_DELIVERY.WHATSAPP);
      return showSettings(m, ctx, "✅ Pengiriman: *WhatsApp (dokumen)*");
    case "hosting":
    case "link":
    case "upload":
      setBackupDelivery(BACKUP_DELIVERY.HOSTING);
      return showSettings(m, ctx, "✅ Pengiriman: *Hosting gratis (link)*");
    case "full":
      setBackupScope(BACKUP_SCOPE.FULL);
      return showSettings(m, ctx, "✅ Cakupan: *Full backup*");
    case "source":
    case "getsc":
      setBackupScope(BACKUP_SCOPE.SOURCE);
      return showSettings(m, ctx, "✅ Cakupan: *Source only (.getsc)*");
    default:
      return m.reply(
        `📦 *Backup*\n\n` +
          `> \`${prefix}backup\` — cek struktur & ukuran\n` +
          `> \`${prefix}backup start\` — mulai backup\n` +
          `> \`${prefix}backup setting\` — atur pengiriman & cakupan`,
      );
  }
}

export { pluginConfig as config, handler };
