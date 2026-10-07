/**
 * GX-ID — /pdfto
 *
 * The inverse of `/pdf`: take a PDF and turn it into an editable file — DOCX,
 * TXT, MD, HTML, RTF (built-in, no external tool) or PNG/JPG (via LibreOffice,
 * when installed).
 *
 * UX: reply to a PDF with `.pdfto` and the bot answers with an **interactive
 * button sheet** listing the target formats. Tapping a row converts the file
 * and sends the result back. A direct `.pdfto <format>` skips the picker.
 *
 * The PDF is downloaded once, kept in memory under a short-lived token
 * (`lib/pdf-jobs.js`) and only converted when a row is tapped — so a picker the
 * user ignores never costs a conversion. The token is bound to the chat it was
 * minted in.
 */
import config from "../../config.js";
import { getImageBuffer } from "../../lib/asset-manager.js";
import { formatFileSize } from "../../lib/formatter.js";
import { registerFlowRoute } from "../../lib/flow-router.js";
import { sendNativeFlow, createSingleSelect, buildMessageParams } from "../../lib/flow.js";
import { resolveExtension, classifyExtension, isLibreOfficeAvailable } from "../../lib/pdf-convert.js";
import { PDF_EXPORT_TARGETS, getExportTarget, convertFromPdf, imageTargetsAvailable } from "../../lib/pdf-export.js";
import { createJob, getJob, dropJob } from "../../lib/pdf-jobs.js";

const pluginConfig = {
  name: "pdfto",
  alias: ["frompdf", "pdf2", "pdfconvert", "pdf2docx", "pdfto"],
  category: "pdf-tools",
  description: "Convert a PDF into DOCX/TXT/MD/HTML/RTF (or PNG/JPG)",
  usage: ".pdfto (reply to a PDF)",
  example: ".pdfto",
  isOwner: false,
  isPremium: false,
  isGroup: false,
  isPrivate: false,
  cooldown: 15,
  isEnabled: true,
  helpOnEmpty: false,
};

/* ─────────────────────────────── helpers ─────────────────────────────── */

/** Pick the media-bearing message: the reply, else the message itself. */
function resolveTarget(m) {
  const quoted = m.quoted;
  if (quoted && (quoted.isDocument || quoted.isMedia)) return quoted;
  if (m.isDocument) return m;
  return null;
}

/** `report.pdf` → `report` (sanitised, no extension). */
function stemOf(original = "") {
  const base = String(original).split(/[\\/]/).pop() || "";
  return base.replace(/\.[^.]*$/, "").replace(/[^\w\-. ]+/g, "_").trim() || "converted";
}

/** Build the picker rows for the available targets, each carrying `token`. */
function targetRows(token) {
  const images = imageTargetsAvailable();
  const rows = PDF_EXPORT_TARGETS.map((t) => {
    const needsLo = t.engine === "libreoffice";
    const description = needsLo && !images ? `${t.description} — ❌ butuh LibreOffice` : t.description;
    return { id: `pdfto:to:${token}:${t.id}`, title: `${t.emoji} ${t.label}`, description };
  });
  rows.push({ id: `pdfto:cancel:${token}`, title: "✖️ Batal", description: "Tutup pilihan" });
  return rows;
}

/** Show the interactive format picker for an already-downloaded PDF. */
async function sendPicker(m, ctx, job) {
  const { sock, config: cfg } = ctx;
  const botName = cfg?.bot?.name || config.bot?.name || "GX-ID";

  const image = await getImageBuffer("menu", botName).catch(() => null);
  const body =
    `📥 *PDF → Dokumen*\n\n` +
    `∝ Sumber : *${job.fileName || "file.pdf"}*\n` +
    `∝ Ukuran : *${formatFileSize(job.buffer.length)}*\n` +
    (imageTargetsAvailable() ? "" : `\n> ℹ️ PNG/JPG butuh LibreOffice (belum terpasang).\n`) +
    `\n> Pilih format tujuan di bawah ini.`;

  const ok = await sendNativeFlow(sock, m.chat, {
    image,
    headerTitle: botName,
    body,
    footer: `${botName} • PDF Converter`,
    buttons: [
      createSingleSelect({
        title: "📂 PILIH FORMAT",
        sectionTitle: "FORMAT TUJUAN",
        highlightLabel: "Format",
        rows: targetRows(job.token),
      }),
    ],
    messageParamsJson: buildMessageParams({ listTitle: "FORMAT", buttonTitle: "PILIH" }),
    quoted: m.raw,
    mentionedJid: m.sender ? [m.sender] : [],
    fallbackLabel: "pdfto",
  });

  if (!ok) {
    const list = PDF_EXPORT_TARGETS.map((t) => `┃ ${t.emoji} *${t.label}* — ${t.description}`).join("\n");
    await m
      .reply(
        `📥 *PDF → Dokumen*\n\n` +
          `> ${job.fileName || "file.pdf"} · ${formatFileSize(job.buffer.length)}\n\n` +
          `${list}\n\n` +
          `> Balas PDF-nya dengan \`${m.prefix || "."}pdfto <format>\` untuk konversi langsung.`,
      )
      .catch(() => {});
  }
  return true;
}

/** Convert `job.buffer` into `targetId` and send the result. */
async function convertAndSend(m, ctx, job, targetId) {
  const { sock } = ctx;
  const target = getExportTarget(targetId);
  if (!target) {
    await m.reply("❌ Format tujuan tidak dikenal.").catch(() => {});
    return true;
  }

  await m.react("🕕").catch(() => {});
  try {
    const result = await convertFromPdf(job.buffer, target, { fileName: job.fileName });
    const outName = `${stemOf(job.fileName)}.${result.extension}`;

    const caption =
      `📥 *PDF Converter*\n\n` +
      `> ${job.fileName || "file.pdf"}\n` +
      `> ${formatFileSize(job.buffer.length)} → ${formatFileSize(result.buffer.length)} · ${target.label}` +
      (result.warning ? `\n> ⚠️ ${result.warning}` : "");

    if (target.engine === "libreoffice") {
      await sock.sendMessage(m.chat, { image: result.buffer, caption }, { quoted: m.raw });
    } else {
      await sock.sendMessage(
        m.chat,
        { document: result.buffer, mimetype: result.mimetype, fileName: outName, caption },
        { quoted: m.raw },
      );
    }
    await m.react("✅").catch(() => {});
  } catch (error) {
    await m.react("☢").catch(() => {});
    await m.reply(`📥 *PDF Converter*\n\n> ❌ ${error.message}`).catch(() => {});
  }
  return true;
}

/* ─────────────────────────── flow route (taps) ─────────────────────────── */

registerFlowRoute("pdfto", async (m, ctx, { action, args }) => {
  switch (action) {
    case "to": {
      const [token, targetId] = args;
      if (!token || !targetId) return false;
      const job = getJob(token, m.chat);
      if (!job) {
        await m
          .reply("⌛ *Sesi konversi sudah kedaluwarsa.*\n\n> Balas ulang PDF-nya dengan `.pdfto` untuk memulai lagi.")
          .catch(() => {});
        return true;
      }
      dropJob(token);
      return convertAndSend(m, ctx, job, targetId);
    }
    case "cancel": {
      const [token] = args;
      if (token) dropJob(token);
      await m.reply("✖️ *Dibatalkan.*").catch(() => {});
      return true;
    }
    default:
      return false;
  }
});

/* ─────────────────────────────── handler ─────────────────────────────── */

async function handler(m, ctx) {
  const prefix = m.prefix || config.command?.prefix || ".";
  const argFormat = String(m.args?.[0] || "").toLowerCase();

  const target = resolveTarget(m);
  if (!target) {
    return m.reply(
      `📥 *PDF Converter*\n\n` +
        `> Balas sebuah file PDF dengan \`${prefix}pdfto\`.\n` +
        `> Bot akan menampilkan pilihan format (interactive button).\n\n` +
        `*Format:* DOCX, TXT, MD, HTML, RTF${isLibreOfficeAvailable() ? ", PNG, JPG" : " (PNG/JPG butuh LibreOffice)"}.\n` +
        `*Langsung:* \`${prefix}pdfto docx\` untuk melewati pilihan.`,
    );
  }

  const fileName = target.fileName || "";
  const mimetype = target.mimetype || "";
  const ext = resolveExtension(fileName, mimetype);

  if (classifyExtension(ext) !== "pdf") {
    return m.reply(
      `📥 *PDF Converter*\n\n> ❌ File ini bukan PDF${ext ? ` (.${ext})` : ""}.\n> Gunakan \`${prefix}pdf\` untuk mengubah dokumen menjadi PDF.`,
    );
  }

  /* direct format (`.pdfto docx`) — validate before downloading */
  if (argFormat) {
    const direct = getExportTarget(argFormat);
    if (!direct) {
      const list = PDF_EXPORT_TARGETS.map((t) => `\`${t.id}\``).join(", ");
      return m.reply(`📥 *PDF Converter*\n\n> ❌ Format \`${argFormat}\` tidak dikenal.\n> Pilihan: ${list}`);
    }
    await m.react("🕕").catch(() => {});
    let buffer;
    try {
      buffer = await target.download();
    } catch {
      buffer = null;
    }
    if (!buffer) {
      await m.react("☢").catch(() => {});
      return m.reply("📥 *PDF Converter*\n\n> ❌ Gagal mengunduh file.");
    }
    return convertAndSend(m, ctx, { buffer, fileName: fileName || "file.pdf" }, direct.id);
  }

  /* interactive picker — download once, keep it under a token */
  await m.react("🕕").catch(() => {});
  let buffer;
  try {
    buffer = await target.download();
  } catch {
    buffer = null;
  }
  if (!buffer) {
    await m.react("☢").catch(() => {});
    return m.reply("📥 *PDF Converter*\n\n> ❌ Gagal mengunduh file.");
  }

  const token = createJob({ buffer, fileName: fileName || "file.pdf", chat: m.chat, sender: m.sender });
  if (!token) {
    await m.react("☢").catch(() => {});
    return m.reply("📥 *PDF Converter*\n\n> ❌ File terlalu besar atau kosong.");
  }

  await m.react("📥").catch(() => {});
  return sendPicker(m, ctx, { buffer, fileName: fileName || "file.pdf", token });
}

export { pluginConfig as config, handler };

/* exported for reuse/testing */
export { resolveTarget, stemOf, targetRows };
