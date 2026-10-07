/**
 * GX-ID — /pdf
 *
 * Convert a document or image into a tidy PDF, entirely on the bot host, and
 * send the result back to the chat.
 *
 *   • Office formats (docx, pptx, xlsx, odt, rtf …) → LibreOffice headless.
 *     When LibreOffice is not installed the command explains how to enable it.
 *   • Images (jpg, png, webp …)                     → built-in PDF writer.
 *   • Text files (txt, md, csv, json …)             → built-in PDF writer.
 *
 * The target is the replied message when it carries a file, otherwise the
 * current message when it is itself a document/image. Conversion and limits
 * live in `lib/pdf-convert.js`.
 */
import { convertToPdf, resolveExtension, classifyExtension, isLibreOfficeAvailable } from "../../lib/pdf-convert.js";

const ENGINE_LABEL = {
  libreoffice: "LibreOffice",
  "builtin-image": "Gambar → PDF",
  "builtin-text": "Teks → PDF",
  passthrough: "PDF",
};

const pluginConfig = {
  name: "topdf",
  alias: ["topdf", "convertpdf", "jadipdf"],
  category: "utility",
  description: "Convert a document/image to PDF",
  usage: ".pdf (reply to a document/image)",
  example: ".pdf",
  isOwner: false,
  isPremium: false,
  isGroup: false,
  isPrivate: false,
  cooldown: 15,
  isEnabled: true,
};

/** Pick the media-bearing message: the reply, else the message itself. */
function resolveTarget(m) {
  const quoted = m.quoted;
  if (quoted && (quoted.isDocument || quoted.isImage || quoted.isMedia)) return quoted;
  if (m.isDocument || m.isImage) return m;
  return null;
}

/** Strip any extension and sanitise the base name for the output file. */
function outputFileName(original = "") {
  const base = String(original).split(/[\\/]/).pop() || "";
  const stem = base.replace(/\.[^.]*$/, "").replace(/[^\w\-. ]+/g, "_").trim();
  return `${stem || "converted"}.pdf`;
}

/** Human-readable byte size. */
function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function handler(m, { sock, config }) {
  const prefix = m.prefix || config.command?.prefix || ".";

  const target = resolveTarget(m);
  if (!target) {
    return m.reply(
      `📄 *PDF Converter*\n\n` +
        `> Reply to a document or image with \`${prefix}pdf\`.\n\n` +
        `*Didukung:* Office (docx, pptx, xlsx, odt, rtf), gambar (jpg, png, webp), teks (txt, md, csv, json).\n` +
        `*LibreOffice:* ${isLibreOfficeAvailable() ? "terpasang ✅" : "tidak terpasang (format Office dinonaktifkan)"}`,
    );
  }

  const fileName = target.fileName || "";
  const mimetype = target.mimetype || "";
  const ext = resolveExtension(fileName, mimetype);

  if (classifyExtension(ext) === "pdf") {
    return m.reply("📄 File ini sudah berupa PDF.");
  }

  await m.react("🕕");
  try {
    const input = await target.download();
    if (!input) throw new Error("Gagal mengunduh file");

    const { buffer, engine, extension } = await convertToPdf(input, { fileName, mimetype });

    await sock.sendMessage(
      m.chat,
      {
        document: buffer,
        mimetype: "application/pdf",
        fileName: outputFileName(fileName || `converted.${extension}`),
        caption:
          `📄 *PDF Converter*\n\n` +
          `> ${fileName || `file.${extension}`}\n` +
          `> ${humanSize(input.length)} → ${humanSize(buffer.length)} · ${ENGINE_LABEL[engine] || engine}`,
      },
      { quoted: m.raw },
    );
    await m.react("✅");
  } catch (error) {
    await m.react("☢");
    return m.reply(`📄 *PDF Converter*\n\n> ❌ ${error.message}`);
  }
}

export { pluginConfig as config, handler };
