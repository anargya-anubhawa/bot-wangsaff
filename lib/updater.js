/**
 * GX-ID — GitHub self-update service
 *
 * Powers the `.update` / `.checkupdate` commands. It talks to the public
 * GitHub REST API (no SDK, no extra dependency) to:
 *
 *   1. resolve the configured repository / branch,
 *   2. compare the *applied* baseline commit against the remote head,
 *   3. report every new commit (message, author and changed files), and
 *   4. overlay the remote tree onto the local bot files.
 *
 * The repository is configured entirely through the environment (see
 * `.env.example`), never hardcoded:
 *
 *   GITHUB_REPO          owner/repo | owner/repo#branch | https://github.com/owner/repo
 *   GITHUB_BRANCH        branch/tag/sha override (optional)
 *   GITHUB_TOKEN         personal access token for private repos / rate limits
 *   UPDATE_AUTO_RESTART  "true" to let the caller restart after applying
 *
 * Safety guarantees for `applyUpdate`:
 *   • NEVER deletes a local file — it only adds new files and overwrites
 *     existing ones that the repository ships;
 *   • the sensitive paths in `PROTECTED_ROOTS` are never touched;
 *   • every file it is about to overwrite is first backed up under
 *     `storage/backups/update-<timestamp>/`;
 *   • the tarball is sanity-checked (must look like the bot project) and size
 *     limited before a single byte is written.
 */
import fs from "fs";
import path from "path";
import zlib from "zlib";
import config from "../config.js";
import { getDatabase } from "./database.js";
import { logger } from "./logger.js";

const API_BASE = "https://api.github.com";
const USER_AGENT = "GX-ID-Updater";

/** Newest commits whose per-file detail is fetched (extra API calls). */
export const MAX_COMMIT_DETAIL = 8;

/** Refuse to extract a tarball larger than this. */
export const MAX_TARBALL_BYTES = 256 * 1024 * 1024;

/**
 * Local paths that must never be written by an update — runtime state,
 * secrets and vendored dependencies. Anything under one of these top-level
 * names is skipped.
 */
export const PROTECTED_ROOTS = ["session", "storage", "database", "node_modules", ".git", "backups"];

/** Message shown when `GITHUB_REPO` is missing. */
export const NOT_CONFIGURED_MESSAGE =
  "⚠️ *Update belum dikonfigurasi.*\n\n> Set `GITHUB_REPO` di `.env` (mis. `owner/repo` atau `https://github.com/owner/repo`).\n> Opsional: `GITHUB_BRANCH`, `GITHUB_TOKEN`.";

/** Error carrying a machine-readable `code` for the command layer. */
export class UpdateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "UpdateError";
    this.code = code;
  }
}

/* ───────────────────────────── repository parsing ───────────────────────────── */

/**
 * Parse a repository reference into `{ owner, repo, branch }`.
 * Accepts `owner/repo`, `owner/repo#branch`, `https://github.com/owner/repo`
 * (with an optional `.git` suffix or trailing `#branch`). Returns `null` when
 * the value cannot be understood.
 */
export function parseRepo(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;

  let text = raw;
  let branch = "";
  const hash = text.indexOf("#");
  if (hash !== -1) {
    branch = text.slice(hash + 1).trim();
    text = text.slice(0, hash).trim();
  }

  text = text
    .replace(/^https?:\/\/[^/]*github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/^\/+|\/+$/g, "");

  const parts = text.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const [owner, repo] = parts;
  if (!owner || !repo) return null;
  return { owner, repo, branch };
}

function getParsedRepo() {
  const parsed = parseRepo(config.update?.repo);
  if (!parsed) return null;
  return { ...parsed, branch: String(config.update?.branch || parsed.branch || "").trim() };
}

/** Is a usable repository configured? */
export function isConfigured() {
  return !!getParsedRepo();
}

/** `owner/repo` (optionally `owner/repo@branch`) for display. */
export function getRepoLabel(branch = "") {
  const parsed = getParsedRepo();
  if (!parsed) return "";
  const ref = branch || parsed.branch;
  return ref ? `${parsed.owner}/${parsed.repo}@${ref}` : `${parsed.owner}/${parsed.repo}`;
}

/* ───────────────────────────── baseline persistence ───────────────────────────── */

const BASELINE_KEY = "updateCommit";

/** The commit SHA most recently applied locally, or null. */
export function getBaseline() {
  try {
    const value = getDatabase().setting(BASELINE_KEY);
    return value ? String(value) : null;
  } catch {
    return null;
  }
}

/** Record the commit SHA that is now applied locally. */
export function setBaseline(sha) {
  try {
    getDatabase().setting(BASELINE_KEY, sha ? String(sha) : null);
  } catch {
    /* database not ready */
  }
}

/* ───────────────────────────── GitHub REST helpers ───────────────────────────── */

function requestHeaders() {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": USER_AGENT,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = String(config.update?.token || "").trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function rateLimitHint(res) {
  const remaining = res.headers?.get?.("x-ratelimit-remaining");
  const reset = res.headers?.get?.("x-ratelimit-reset");
  if (remaining === "0" && reset) {
    const at = new Date(Number(reset) * 1000);
    return ` (rate limit habis, reset ${at.toISOString()})`;
  }
  return "";
}

async function apiGet(apiPath) {
  const url = `${API_BASE}${apiPath}`;
  let res;
  try {
    res = await fetch(url, { headers: requestHeaders() });
  } catch (error) {
    throw new UpdateError("network", `❌ Gagal menghubungi GitHub: ${error.message}`);
  }
  if (!res.ok) {
    if (res.status === 404) {
      throw new UpdateError("not-found", "❌ Repositori/branch tidak ditemukan (404). Periksa `GITHUB_REPO`/`GITHUB_BRANCH`.");
    }
    if (res.status === 401 || res.status === 403) {
      throw new UpdateError("auth", `❌ Akses GitHub ditolak (${res.status})${rateLimitHint(res)}. Cek \`GITHUB_TOKEN\`.`);
    }
    throw new UpdateError("http", `❌ GitHub membalas ${res.status}${rateLimitHint(res)}.`);
  }
  try {
    return await res.json();
  } catch (error) {
    throw new UpdateError("bad-json", `❌ Respons GitHub tidak valid: ${error.message}`);
  }
}

/** The repository's default branch. */
async function defaultBranch(parsed) {
  const info = await apiGet(`/repos/${parsed.owner}/${parsed.repo}`);
  return info.default_branch || "main";
}

/**
 * Resolve the ref to operate on: an explicit override, else the configured
 * branch, else the repository default branch.
 */
async function resolveRef(parsed, explicitRef = "") {
  const ref = String(explicitRef || "").trim() || parsed.branch;
  if (ref) return ref;
  return defaultBranch(parsed);
}

/** Fetch a single commit reference (sha + commit metadata). */
export async function fetchRef(ref) {
  const parsed = getParsedRepo();
  if (!parsed) throw new UpdateError("not-configured", NOT_CONFIGURED_MESSAGE);
  const target = await resolveRef(parsed, ref);
  const data = await apiGet(`/repos/${parsed.owner}/${parsed.repo}/commits/${encodeURIComponent(target)}`);
  return { sha: data.sha, ref: target, commit: data.commit || {}, htmlUrl: data.html_url || "" };
}

/** Fetch a commit including its changed `files[]`. */
export async function fetchCommitDetail(sha) {
  const parsed = getParsedRepo();
  if (!parsed) throw new UpdateError("not-configured", NOT_CONFIGURED_MESSAGE);
  return apiGet(`/repos/${parsed.owner}/${parsed.repo}/commits/${encodeURIComponent(sha)}`);
}

/** Compare `base...head`; returns `{ status, commits, files, aheadBy }`. */
export async function compareCommits(base, head) {
  const parsed = getParsedRepo();
  if (!parsed) throw new UpdateError("not-configured", NOT_CONFIGURED_MESSAGE);
  const data = await apiGet(
    `/repos/${parsed.owner}/${parsed.repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
  );
  return {
    status: data.status,
    aheadBy: data.ahead_by ?? 0,
    behindBy: data.behind_by ?? 0,
    commits: data.commits || [],
    files: data.files || [],
  };
}

/* ───────────────────────────── reporting ───────────────────────────── */

function summarizeCommit(detail) {
  const commit = detail?.commit || {};
  const author = commit.author || {};
  return {
    sha: detail?.sha || "",
    shortSha: String(detail?.sha || "").slice(0, 7),
    message: String(commit.message || "").split("\n")[0],
    comment: String(commit.message || "").trim(),
    author: author.name || detail?.author?.login || "unknown",
    date: author.date || null,
    files: (detail?.files || []).map((f) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions ?? 0,
      deletions: f.deletions ?? 0,
    })),
  };
}

/**
 * Compare the applied baseline with the remote head.
 *
 * @param {{ ref?: string }} [options]
 * @returns {Promise<object>} a report describing what (if anything) changed.
 */
export async function checkForUpdates({ ref = "" } = {}) {
  const parsed = getParsedRepo();
  if (!parsed) throw new UpdateError("not-configured", NOT_CONFIGURED_MESSAGE);

  const target = await resolveRef(parsed, ref);
  const head = await fetchRef(target);
  const baseline = getBaseline();
  const repo = getRepoLabel(target);

  if (baseline && baseline === head.sha) {
    return { status: "up-to-date", repo, ref: target, head, baseline, commits: [], totalCommits: 0, totalFiles: 0 };
  }

  /* No baseline yet (first run) — report only the latest commit. */
  if (!baseline) {
    const detail = await fetchCommitDetail(head.sha);
    return {
      status: "no-baseline",
      repo,
      ref: target,
      head,
      baseline: null,
      commits: [summarizeCommit(detail)],
      totalCommits: 1,
      totalFiles: (detail.files || []).length,
    };
  }

  const cmp = await compareCommits(baseline, head.sha);
  const all = cmp.commits || [];
  /* newest first, capped at MAX_COMMIT_DETAIL for the per-file detail calls */
  const picked = all.slice(Math.max(0, all.length - MAX_COMMIT_DETAIL)).reverse();
  const commits = [];
  for (const c of picked) {
    try {
      commits.push(summarizeCommit(await fetchCommitDetail(c.sha)));
    } catch {
      /* fall back to the (file-less) compare entry */
      commits.push(summarizeCommit(c));
    }
  }

  return {
    status: "behind",
    repo,
    ref: target,
    head,
    baseline,
    commits,
    totalCommits: all.length,
    totalFiles: (cmp.files || []).length,
  };
}

/* ───────────────────────────── tarball extraction ───────────────────────────── */

/** Read a NUL-terminated UTF-8 string from a fixed-width header field. */
function readField(buf, start, len) {
  return buf.subarray(start, start + len).toString("utf8").replace(/\0.*$/s, "");
}

/** Parse a NUL/space-terminated octal number. */
function parseOctal(buf) {
  const text = buf.toString("utf8").replace(/\0.*$/s, "").trim();
  if (!text) return 0;
  const value = parseInt(text, 8);
  return Number.isFinite(value) ? value : 0;
}

function isZeroBlock(buf) {
  for (let i = 0; i < buf.length; i++) if (buf[i] !== 0) return false;
  return true;
}

/**
 * Extract a `.tar.gz` buffer into `[{ path, data }]` — regular files only.
 * Supports ustar prefix fields, GNU long names (`L`) and PAX headers (`x`/`g`).
 */
export function extractTarGz(buffer) {
  const tar = zlib.gunzipSync(buffer);
  const entries = [];
  let offset = 0;
  let gnuLongName = null;
  let paxPath = null;

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (isZeroBlock(header)) {
      offset += 512;
      continue;
    }

    const nameField = readField(header, 0, 100);
    const prefixField = readField(header, 345, 155);
    const size = parseOctal(header.subarray(124, 136));
    const typeflag = String.fromCharCode(header[156] || 48);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    const raw = tar.subarray(dataStart, Math.min(dataEnd, tar.length));
    offset = dataStart + Math.ceil(size / 512) * 512;

    if (typeflag === "L") {
      gnuLongName = raw.toString("utf8").replace(/\0.*$/s, "");
      continue;
    }
    if (typeflag === "x" || typeflag === "g") {
      for (const line of raw.toString("utf8").split("\n")) {
        const eq = line.indexOf("=");
        if (eq === -1) continue;
        const key = line.slice(0, eq).replace(/^\d+ /, "").trim();
        if (key === "path") paxPath = line.slice(eq + 1);
      }
      continue;
    }

    const fullName = paxPath || gnuLongName || (prefixField ? `${prefixField}/${nameField}` : nameField);
    paxPath = null;
    gnuLongName = null;
    if (!fullName) continue;

    /* directories and non-regular entries (symlinks, devices) are skipped */
    if (typeflag === "5" || fullName.endsWith("/")) continue;
    if (typeflag !== "0" && typeflag !== "\0" && typeflag !== "7") continue;

    entries.push({ path: fullName.replace(/^\.\//, ""), data: Buffer.from(raw) });
  }

  return entries;
}

/** Drop the single top-level directory GitHub wraps every tarball in. */
function stripTopDir(entries) {
  if (!entries.length) return entries;
  const top = entries[0].path.split("/")[0];
  if (!top || !entries[0].path.includes("/")) return entries;
  const prefix = `${top}/`;
  return entries
    .filter((e) => e.path.startsWith(prefix))
    .map((e) => ({ path: e.path.slice(prefix.length), data: e.data }));
}

/** Should this relative path be left untouched by an update? */
export function isProtectedPath(rel) {
  const clean = String(rel || "").replace(/\\/g, "/").replace(/^\.\//, "");
  if (!clean) return true;
  const segments = clean.split("/");
  const top = segments[0];
  if (PROTECTED_ROOTS.includes(top)) return true;
  if (clean === ".env") return true;
  /* keep .env.example updatable, protect the other .env.* variants */
  if (segments.length === 1 && clean.startsWith(".env.") && clean !== ".env.example") return true;
  return false;
}

async function downloadTarball(sha) {
  const parsed = getParsedRepo();
  const url = `${API_BASE}/repos/${parsed.owner}/${parsed.repo}/tarball/${encodeURIComponent(sha)}`;
  let res;
  try {
    res = await fetch(url, { headers: requestHeaders(), redirect: "follow" });
  } catch (error) {
    throw new UpdateError("network", `❌ Gagal mengunduh update: ${error.message}`);
  }
  if (!res.ok) {
    throw new UpdateError("http", `❌ Gagal mengunduh update (${res.status}).`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_TARBALL_BYTES) {
    throw new UpdateError("too-large", `❌ Arsip update terlalu besar (${buf.length} byte).`);
  }
  return buf;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * Overlay the remote tree onto the local bot files.
 *
 * @param {{ ref?: string, dryRun?: boolean }} [options]
 * @returns {Promise<object>} an apply report.
 */
export async function applyUpdate({ ref = "", dryRun = false } = {}) {
  const parsed = getParsedRepo();
  if (!parsed) throw new UpdateError("not-configured", NOT_CONFIGURED_MESSAGE);

  const target = await resolveRef(parsed, ref);
  const head = await fetchRef(target);
  const baseline = getBaseline();
  const repo = getRepoLabel(target);

  if (baseline && baseline === head.sha) {
    return { status: "up-to-date", repo, ref: target, head, baseline, applied: 0, files: [], skipped: [] };
  }

  const buffer = await downloadTarball(head.sha);
  const entries = stripTopDir(extractTarGz(buffer));
  if (!entries.some((e) => e.path === "package.json" || e.path === "index.js")) {
    throw new UpdateError("bad-tarball", "❌ Arsip update tidak dikenali (bukan proyek GX-ID).");
  }

  const root = path.resolve(process.cwd());
  const backupDir = path.join(root, "storage", "backups", `update-${timestamp()}`);
  const written = [];
  const skipped = [];

  for (const entry of entries) {
    const rel = entry.path.replace(/\\/g, "/");
    if (isProtectedPath(rel)) {
      skipped.push(rel);
      continue;
    }
    const dest = path.resolve(root, rel);
    if (dest !== root && !dest.startsWith(root + path.sep)) {
      skipped.push(rel);
      continue;
    }
    if (!dryRun) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (fs.existsSync(dest)) {
        const backupPath = path.join(backupDir, rel);
        fs.mkdirSync(path.dirname(backupPath), { recursive: true });
        fs.copyFileSync(dest, backupPath);
      }
      fs.writeFileSync(dest, entry.data);
    }
    written.push(rel);
  }

  if (!dryRun) setBaseline(head.sha);
  logger.info(`update ${dryRun ? "(dry-run) " : ""}applied ${written.length} file(s) from ${repo}`);

  return {
    status: "updated",
    repo,
    ref: target,
    head,
    baseline,
    applied: written.length,
    files: written,
    skipped,
    backupDir: dryRun ? null : backupDir,
  };
}
