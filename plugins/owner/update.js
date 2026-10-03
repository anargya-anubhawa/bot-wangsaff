/**
 * GX-ID — /update & /checkupdate (owner only)
 *
 * Self-update straight from the repository configured in `.env`
 * (`GITHUB_REPO` / `GITHUB_BRANCH` / `GITHUB_TOKEN`). One merged, parameter
 * driven command:
 *
 *   .update                → periksa lalu terapkan update (bare = apply)
 *   .update check          → laporkan commit baru (nama, file, komentar)
 *   .update help           → kartu usage + parameter
 *   .update <ref>          → terapkan dari branch/tag/commit tertentu
 *
 * Every former entry point is kept as an alias so both styles work:
 *   checkupdate/cekupdate/updatecheck        → cek update
 *   upgrade/updatebot/pullupdate/updategit   → terapkan update
 *
 * The heavy lifting lives in `lib/updater.js` (GitHub REST + tar overlay).
 * Files under `session/`, `storage/`, `database/`, `node_modules/`, `.git/`
 * and `.env` are never touched, and every overwritten file is backed up first.
 */
import {
  isConfigured,
  checkForUpdates,
  applyUpdate,
  NOT_CONFIGURED_MESSAGE,
  MAX_COMMIT_DETAIL,
} from "../../lib/updater.js";
import { renderCommandUsage } from "../../lib/command-usage.js";

const CHECK_ALIASES = ["checkupdate", "cekupdate", "updatecheck"];
const APPLY_ALIASES = ["upgrade", "updatebot", "pullupdate", "updategit"];

const pluginConfig = {
  name: "update",
  alias: [...CHECK_ALIASES, ...APPLY_ALIASES],
  category: "owner",
  description: "Periksa & terapkan update bot dari repositori GitHub",
  usage: ".update [check|help|<ref>]",
  examples: [".update", ".update check", ".update main", ".update v1.2.0"],
  parameters: [
    { name: "check", description: "Laporkan commit baru (nama, file, komentar) tanpa menerapkan" },
    { name: "help", description: "Tampilkan kartu usage + parameter" },
    { name: "<ref>", description: "Terapkan dari branch/tag/commit tertentu (default: branch repo)" },
  ],
  helpOnEmpty: false,
  permission: "owner",
  cooldown: 3,
  isEnabled: true,
};

/* ───────────────────────────── rendering ───────────────────────────── */

const STATUS_LETTER = { added: "A", removed: "D", modified: "M", renamed: "R", copied: "C", changed: "M" };

function shortSha(sha) {
  return String(sha || "").slice(0, 7);
}

function statusLetter(status) {
  return STATUS_LETTER[String(status || "").toLowerCase()] || "?";
}

/** First line of a commit message. */
function firstLine(message) {
  return String(message || "").split("\n")[0].trim();
}

function renderCommitBlock(commit, index) {
  const L = [];
  L.push(`╭─〔 ${index}. \`${commit.shortSha}\` 〕`);
  const who = [commit.author, commit.date ? new Date(commit.date).toISOString().slice(0, 10) : null]
    .filter(Boolean)
    .join(" · ");
  if (who) L.push(`┃ ✍️ ${who}`);
  if (commit.message) L.push(`┃ 💬 ${commit.message}`);
  /* multi-line commit comment (body), if any */
  const body = String(commit.comment || "")
    .split("\n")
    .slice(1)
    .map((l) => l.trim())
    .filter(Boolean);
  if (body.length) L.push(`┃ 📝 ${body.join(" ")}`);

  const files = commit.files || [];
  if (files.length) {
    L.push(`┃ 📂 *Files (${files.length}):*`);
    for (const f of files.slice(0, 10)) {
      L.push(`┃   › \`${statusLetter(f.status)}\` ${f.filename} (+${f.additions} -${f.deletions})`);
    }
    if (files.length > 10) L.push(`┃   › … +${files.length - 10} file lainnya`);
  }
  L.push(`╰─⬣`);
  return L.join("\n");
}

function renderCheck(report, prefix) {
  const L = [];
  L.push(`🔎 *CEK UPDATE · GX-ID*`);
  L.push("");
  L.push(`╭─〔 📦 *REPOSITORI* 〕`);
  L.push(`┃ Repo   : \`${report.repo}\``);
  L.push(`┃ Remote : \`${shortSha(report.head?.sha)}\` — ${firstLine(report.head?.commit?.message) || "-"}`);
  L.push(
    `┃ Lokal  : ${report.baseline ? `\`${shortSha(report.baseline)}\`` : "_belum tercatat_"}`,
  );
  L.push(`╰─⬣`);

  if (report.status === "up-to-date") {
    L.push("");
    L.push(`✅ *Sudah versi terbaru.*`);
    L.push(`> Commit: \`${shortSha(report.head?.sha)}\``);
    return L.join("\n");
  }

  if (report.status === "no-baseline") {
    L.push("");
    L.push(`ℹ️ *Belum ada baseline lokal.*`);
    L.push(`> Commit terbaru: \`${shortSha(report.head?.sha)}\` — ${firstLine(report.head?.commit?.message) || "-"}`);
    L.push(`> Jalankan \`${prefix}update\` untuk menyamakan & mencatat baseline.`);
    return L.join("\n");
  }

  L.push("");
  L.push(`🆕 *${report.totalCommits} commit baru* · ${report.totalFiles} file berubah`);
  if (report.totalCommits > MAX_COMMIT_DETAIL) {
    L.push(`_Menampilkan ${MAX_COMMIT_DETAIL} terbaru._`);
  }
  L.push("");
  report.commits.forEach((c, i) => {
    L.push(renderCommitBlock(c, i + 1));
    L.push("");
  });
  L.push(`> Terapkan sekarang: \`${prefix}update\``);
  return L.join("\n").trimEnd();
}

function renderApply(report, prefix) {
  const L = [];
  L.push(`✅ *UPDATE SELESAI · GX-ID*`);
  L.push("");
  L.push(`╭─〔 📦 *HASIL* 〕`);
  L.push(`┃ Repo   : \`${report.repo}\``);
  L.push(`┃ Commit : \`${shortSha(report.head?.sha)}\` — ${firstLine(report.head?.commit?.message) || "-"}`);
  L.push(`┃ Ditulis: ${report.applied} file`);
  if (report.skipped?.length) L.push(`┃ Dilewati (dilindungi): ${report.skipped.length} file`);
  if (report.backupDir) L.push(`┃ Backup : \`${report.backupDir.replace(/\\/g, "/")}\``);
  L.push(`╰─⬣`);
  L.push("");
  L.push(`> ♻️ Restart bot untuk menerapkan perubahan.`);
  L.push(`> Cek lagi: \`${prefix}update check\``);
  return L.join("\n");
}

function renderUpToDate(report) {
  return `✅ *Sudah versi terbaru.*\n\n> Repo: \`${report.repo}\`\n> Commit: \`${shortSha(report.head?.sha)}\``;
}

/* ───────────────────────────── actions ───────────────────────────── */

async function requireConfigured(m) {
  if (isConfigured()) return false;
  await m.reply(NOT_CONFIGURED_MESSAGE);
  return true;
}

async function doCheck(m, prefix) {
  if (await requireConfigured(m)) return;
  const report = await checkForUpdates();
  await m.reply(renderCheck(report, prefix));
}

async function doApply(m, ctx, ref) {
  if (await requireConfigured(m)) return;
  const report = await applyUpdate({ ref });
  if (report.status === "up-to-date") {
    await m.reply(renderUpToDate(report));
    return;
  }
  await m.reply(renderApply(report, ctx.prefix || m.prefix || "."));
  if (ctx.config?.update?.autoRestart) {
    await m.reply("♻️ _Auto-restart aktif — bot akan restart…_").catch(() => {});
    setTimeout(() => process.exit(0), 1500);
  }
}

/* ───────────────────────────── handler ───────────────────────────── */

async function handler(m, ctx) {
  const { config } = ctx;
  const prefix = m.prefix || config.command?.prefix || ".";
  const invoked = String(m.command || "update").toLowerCase();
  const args = m.args || [];
  const sub = (args[0] || "").toLowerCase();

  try {
    /* legacy aliases */
    if (CHECK_ALIASES.includes(invoked)) return await doCheck(m, prefix);
    if (APPLY_ALIASES.includes(invoked)) return await doApply(m, ctx, args[0] || "");

    /* primary: `.update <sub|ref>` */
    if (sub === "help" || sub === "bantuan" || sub === "usage") {
      return m.reply(renderCommandUsage(pluginConfig, prefix));
    }
    if (sub === "check" || sub === "cek" || sub === "status") {
      return await doCheck(m, prefix);
    }
    /* bare `.update`, or `.update <ref>` */
    return await doApply(m, ctx, args[0] || "");
  } catch (error) {
    const message = error?.message?.startsWith("⚠️") || error?.message?.startsWith("❌")
      ? error.message
      : `❌ Gagal memproses update: ${error.message}`;
    await m.reply(message).catch(() => {});
  }
}

export { pluginConfig as config, handler };
