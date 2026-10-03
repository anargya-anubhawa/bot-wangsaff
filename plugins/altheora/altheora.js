/**
 * GX-ID — /altheora  (alias: /al)
 *
 * Serves the documents under `assets/altheora` as a single *native flow*
 * interactive message. Every folder is a category and every file is a row —
 * both discovered from the filesystem through the cached asset registry, so
 * adding/removing a folder or PDF is reflected instantly (no restart, no code
 * change).
 *
 * UI (one bubble, no navigation messages):
 *
 *   .altheora
 *     → 📚 ALTHEORA
 *         [ 📄 SOP        ]  ← one single_select per category
 *         [ 📅 KALENDER   ]     rows are the files of that category
 *         [ 📜 TATA TERTIB]
 *     → tap a file row → the PDF is sent as a new document message
 *
 * Row ids are namespaced and self-contained (`altheora:file:<cat>:<key>`), so
 * navigation is fully stateless and two users in the same group can never see
 * each other's selection. User input is NEVER used as a path: the id is looked
 * up in the server-side registry and re-validated against `assets/altheora`.
 *
 * Legacy text sub-commands (`.altheora dir/get/cat`) are kept working so the
 * command still functions if native flow is unavailable on a client.
 */
import fs from "fs";
import config from "../../config.js";
import { getImageBuffer } from "../../lib/asset-manager.js";
import { toSmallCaps, formatFileSize } from "../../lib/formatter.js";
import { registerFlowRoute } from "../../lib/flow-router.js";
import {
  sendNativeFlow,
  createSingleSelect,
  buildMessageParams,
  paginate,
  MAX_FLOW_ROWS,
  MAX_FLOW_BUTTONS,
} from "../../lib/flow.js";
import { getRegistry, collectFiles } from "./_registry.js";
import { resolveFile, scanCategories, scanCategory, findNode } from "./_scanner.js";

const pluginConfig = {
  name: "altheora",
  alias: ["al"],
  category: "altheora",
  description: "Kirim dokumen Altheora",
  usage: ".altheora",
  example: ".altheora",
  isOwner: false,
  isGroup: false,
  isPrivate: false,
  cooldown: 0,
  isEnabled: true,
};

/** Max document size accepted (bytes). Overridable via ALTHEORA_MAX_MB. */
const MAX_FILE_SIZE = (Number(process.env.ALTHEORA_MAX_MB) || 100) * 1024 * 1024;

/**
 * Optional per-category presentation metadata. Discovery stays automatic — this
 * only overrides the emoji/title for known folder keys; unknown folders fall
 * back to a folder-derived title.
 */
const CATEGORY_META = {
  sop: { emoji: "📄", title: "SOP", section: "DOKUMEN SOP" },
  kalender: { emoji: "📅", title: "KALENDER", section: "KALENDER AKADEMIK" },
  "tata-tertib": { emoji: "📜", title: "TATA TERTIB", section: "TATA TERTIB" },
};

const MESSAGES = {
  noCategories: `📂 *Altheora*\n\nBelum ada kategori dokumen yang tersedia.`,
  emptyCategory: (name) => `📂 *${name}*\n\nBelum ada dokumen yang tersedia di kategori ini.`,
  notFound: `❌ *Dokumen tidak tersedia.*\n\n> File mungkin telah dipindahkan atau dihapus.\n> Silakan buka \`.altheora\` lagi untuk memuat ulang daftar.`,
  unsafe: `❌ *Akses ditolak.*\n\n> Path tidak valid atau di luar folder dokumen.`,
  unsupported: (ext) => `❌ *Format file tidak didukung* (${ext || "unknown"}).\n\n> Dokumen ini tidak dapat dikirim.`,
  oversized: (size) => `❌ *Ukuran file terlalu besar.*\n\n> Maksimal ${formatFileSize(MAX_FILE_SIZE)}, file ini ${formatFileSize(size)}.`,
  sendFailed: `❌ *Gagal mengirim dokumen.*\n\n> Silakan coba lagi sebentar.`,
  missingRoot: `📂 *Altheora*\n\n> Folder \`assets/altheora\` belum tersedia.\n> Buat folder tersebut lalu tambahkan sub-folder sebagai kategori.`,
  denied: `❌ *Tidak dapat membaca dokumen.*\n\n> Izin akses file ditolak.`,
};

/* ─────────────────────────── helpers ─────────────────────────── */

function prefixOf(m) {
  return m.prefix || config.command?.prefix || ".";
}

function metaFor(category) {
  return CATEGORY_META[category.id] || {
    emoji: "📁",
    title: category.name.toUpperCase(),
    section: category.name.toUpperCase(),
  };
}

function icon(ext) {
  const e = String(ext || "").toLowerCase();
  if (e === ".pdf") return "📕";
  if (e === ".doc" || e === ".docx") return "📘";
  if (e === ".ppt" || e === ".pptx") return "📙";
  if (e === ".xls" || e === ".xlsx") return "📗";
  if (e === ".jpg" || e === ".jpeg" || e === ".png") return "🖼️";
  return "📄";
}

/* ─────────────────────────── views ─────────────────────────── */

/**
 * Render the category flow. Each category becomes a `single_select` whose rows
 * are that category's files; a category with more than MAX_FLOW_ROWS files is
 * paginated inside its own selector.
 *
 * @param {object} m
 * @param {object} ctx
 * @param {{pages?:Record<string,number>, catPage?:number}} [state]
 */
async function renderFlow(m, ctx, state = {}) {
  const { sock, config: cfg } = ctx;
  const pages = state.pages || {};
  const catPage = state.catPage || 0;

  const registry = getRegistry();
  if (!registry.ok) {
    await m.reply(MESSAGES.missingRoot).catch(() => {});
    return true;
  }

  const categories = registry.categories.filter((c) => c.count > 0);
  if (!categories.length) {
    await m.reply(MESSAGES.noCategories).catch(() => {});
    return true;
  }

  /* paginate the category buttons themselves when there are too many */
  const catTotalPages = Math.max(1, Math.ceil(categories.length / MAX_FLOW_BUTTONS));
  const currentCatPage = Math.min(Math.max(0, catPage), catTotalPages - 1);
  const visible = categories.slice(
    currentCatPage * MAX_FLOW_BUTTONS,
    currentCatPage * MAX_FLOW_BUTTONS + MAX_FLOW_BUTTONS,
  );

  const buttons = [];
  let totalDocs = 0;

  for (const category of visible) {
    const meta = metaFor(category);
    const files = collectFiles(category);
    totalDocs += files.length;
    if (!files.length) continue;

    const page = Math.min(Math.max(0, pages[category.id] || 0), Math.max(0, Math.ceil(files.length / MAX_FLOW_ROWS) - 1));
    const { items, hasNext } = paginate(files, page, MAX_FLOW_ROWS);

    const rows = items.map((file) => ({
      id: `altheora:file:${category.id}:${file.key}`,
      title: `${icon(file.ext)} ${file.title}`,
      description: file.supported ? `${file.description} • ${formatFileSize(file.size)}` : file.description,
    }));
    if (hasNext) {
      rows.push({
        id: `altheora:cat:${category.id}:${page + 1}`,
        title: "➡️ Selanjutnya",
        description: `Halaman ${page + 2}`,
      });
    }
    if (page > 0) {
      rows.push({
        id: `altheora:cat:${category.id}:${page - 1}`,
        title: "⬅️ Sebelumnya",
        description: `Halaman ${page}`,
      });
    }

    buttons.push(
      createSingleSelect({
        title: `${meta.emoji} ${meta.title}`,
        sectionTitle: meta.section,
        highlightLabel: meta.title,
        rows,
      }),
    );
  }

  if (catTotalPages > 1) {
    const navRows = [];
    if (currentCatPage > 0) navRows.push({ id: `altheora:cats:${currentCatPage - 1}`, title: "⬅️ Kategori Sebelumnya", description: `Halaman ${currentCatPage}` });
    if (currentCatPage < catTotalPages - 1) navRows.push({ id: `altheora:cats:${currentCatPage + 1}`, title: "➡️ Kategori Selanjutnya", description: `Halaman ${currentCatPage + 2}` });
    buttons.push(
      createSingleSelect({ title: "📄 HALAMAN", sectionTitle: `HALAMAN ${currentCatPage + 1}/${catTotalPages}`, highlightLabel: "Navigasi", rows: navRows }),
    );
  }

  if (!buttons.length) {
    await m.reply(MESSAGES.noCategories).catch(() => {});
    return true;
  }

  const body =
    `📚 *${toSmallCaps("Altheora")}*\n\n` +
    `∝ ${toSmallCaps("Kategori")} : *${categories.length}*\n` +
    `∝ ${toSmallCaps("Dokumen")}  : *${totalDocs}*\n\n` +
    `> ${toSmallCaps("Pilih dokumen dari flow di bawah untuk langsung dikirim.")}`;

  const imageBuffer = await getImageBuffer("menu", cfg?.bot?.name || "GX-ID").catch(() => null);
  const messageParamsJson = buildMessageParams({ listTitle: "DOKUMEN", buttonTitle: "BUKA" });

  const ok = await sendNativeFlow(sock, m.chat, {
    image: imageBuffer,
    headerTitle: cfg?.bot?.name || "GX-ID",
    body,
    footer: `${cfg?.bot?.name || "GX-ID"} • Altheora`,
    buttons,
    messageParamsJson,
    quoted: m.raw,
    mentionedJid: [m.sender],
    fallbackLabel: "altheora",
  });

  if (!ok) {
    /* legacy fallback — plain text listing */
    const lines = categories
      .map((c) => `┃ ${metaFor(c).emoji} *${c.name}* — ${c.count} dokumen`)
      .join("\n");
    await m.reply(`📚 *Altheora*\n\n${lines}\n\n> Buka \`.altheora\` lagi untuk memuat ulang.`).catch(() => {});
  }
  return true;
}

/** Send the document selected from the flow (server-side resolved). */
async function sendDocument(m, ctx, catKey, nodeKey) {
  const { sock, config: cfg } = ctx;

  const resolved = resolveFile(catKey, nodeKey);
  if (!resolved.ok) {
    if (resolved.error === "unsafe") return m.reply(MESSAGES.unsafe).catch(() => {});
    if (resolved.error === "missing-root") return m.reply(MESSAGES.missingRoot).catch(() => {});
    return m.reply(MESSAGES.notFound).catch(() => {});
  }

  const { node, abs } = resolved;

  if (!node.supported) {
    await m.reply(MESSAGES.unsupported(node.ext)).catch(() => {});
    return true;
  }
  if (node.size && node.size > MAX_FILE_SIZE) {
    await m.reply(MESSAGES.oversized(node.size)).catch(() => {});
    return true;
  }

  let buffer;
  try {
    buffer = fs.readFileSync(abs);
  } catch (error) {
    const denied = error?.code === "EACCES" || error?.code === "EPERM";
    await m.reply(denied ? MESSAGES.denied : MESSAGES.notFound).catch(() => {});
    return true;
  }

  try {
    await sock.sendMessage(
      m.chat,
      {
        document: buffer,
        fileName: node.fileName,
        mimetype: node.mime || "application/octet-stream",
        caption: `${icon(node.ext)} *${node.name}*\n\n> ${cfg?.bot?.name || "GX-ID"} • Altheora`,
      },
      { quoted: m.raw },
    );
  } catch {
    await m.reply(MESSAGES.sendFailed).catch(() => {});
  }
  return true;
}

/* ─────────────────────────── legacy text views ─────────────────────────── */

async function viewLegacyCategories(m) {
  const { ok, error, categories } = scanCategories();
  if (!ok) {
    await m.reply(error === "missing-root" ? MESSAGES.missingRoot : MESSAGES.notFound).catch(() => {});
    return true;
  }
  if (!categories.length) {
    await m.reply(MESSAGES.noCategories).catch(() => {});
    return true;
  }
  const p = prefixOf(m);
  const lines = categories.map((c) => `┃ 📁 *${c.name}* — ${c.count} dokumen`).join("\n");
  await m.reply(
    `📚 *Altheora*\n\n${lines}\n\n> Gunakan flow interaktif: \`${p}altheora\`\n> Atau: \`${p}altheora get <kategori> <file>\``,
  ).catch(() => {});
  return true;
}

async function viewLegacyDirectory(m, catKey, nodeKey = "-") {
  const scan = scanCategory(catKey);
  if (!scan.ok) {
    if (scan.error === "missing-root") return m.reply(MESSAGES.missingRoot).catch(() => {});
    return m.reply(MESSAGES.notFound).catch(() => {});
  }
  const { category, tree } = scan;
  const found = findNode(tree, nodeKey);
  if (!found) return m.reply(MESSAGES.notFound).catch(() => {});

  const node = found.node;
  const children = node.children || [];
  if (!children.length) return m.reply(MESSAGES.emptyCategory(node.name)).catch(() => {});

  const p = prefixOf(m);
  const lines = children
    .map((c) =>
      c.type === "dir"
        ? `┃ 📁 *${c.name}*`
        : `┃ ${icon(c.ext)} ${c.name} — _${formatFileSize(c.size)}_`,
    )
    .join("\n");
  const hint = children
    .filter((c) => c.type === "file")
    .slice(0, 5)
    .map((c) => `> \`${p}altheora get ${catKey} ${c.key}\``)
    .join("\n");
  await m.reply(`📂 *${category.name}*\n\n${lines}\n\n${hint}`).catch(() => {});
  return true;
}

/* ─────────────────────────── flow routes ─────────────────────────── */

registerFlowRoute("altheora", async (m, ctx, { action, args }) => {
  switch (action) {
    case "file": {
      const [cat, key] = args;
      if (!cat || !key) return false;
      return sendDocument(m, ctx, cat, key);
    }
    case "cat": {
      const [cat, page] = args;
      if (!cat) return false;
      return renderFlow(m, ctx, { pages: { [cat]: Number.parseInt(page, 10) || 0 } });
    }
    case "cats": {
      return renderFlow(m, ctx, { catPage: Number.parseInt(args[0], 10) || 0 });
    }
    case "menu":
    case "":
      return renderFlow(m, ctx, {});
    default:
      return false;
  }
});

/* ─────────────────────────── handler ─────────────────────────── */

async function handler(m, ctx) {
  const sub = (m.args[0] || "").toLowerCase();

  try {
    switch (sub) {
      /* legacy text sub-commands (kept for compatibility / fallback) */
      case "cat":
        return await viewLegacyCategories(m);
      case "dir": {
        const catKey = m.args[1];
        const nodeKey = m.args[2] || "-";
        if (!catKey) return await viewLegacyCategories(m);
        return await viewLegacyDirectory(m, catKey, nodeKey);
      }
      case "pick":
      case "get": {
        const catKey = m.args[1];
        const nodeKey = m.args[2];
        if (!catKey || !nodeKey) return await viewLegacyCategories(m);
        return await sendDocument(m, ctx, catKey, nodeKey);
      }
      /* default → native flow */
      case "":
      case "menu":
      case "flow":
      default:
        return await renderFlow(m, ctx, {});
    }
  } catch (error) {
    await m.reply(MESSAGES.sendFailed).catch(() => {});
    return true;
  }
}

export { pluginConfig as config, handler };
export default { config: pluginConfig, handler };

/* exported for reuse/testing */
export { renderFlow, sendDocument, collectFiles };
