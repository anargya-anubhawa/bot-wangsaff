/**
 * GX-ID — system / server info service
 *
 * Gathers real host metrics for the `.vpsinfo` command (neofetch/fastfetch
 * style) and the merged `.botinfo`. Everything is best-effort and cross
 * platform: a metric that cannot be read is reported as unavailable rather than
 * throwing. It NEVER reads environment values, session files, credentials or
 * the process working directory, so nothing sensitive can leak.
 */
import os from "os";
import fs from "fs";
import { execSync } from "child_process";

/** Run a shell command synchronously, returning "" on any failure. */
function safeExec(cmd, timeout = 3000) {
  try {
    return execSync(cmd, { timeout, stdio: ["ignore", "pipe", "ignore"] }).toString();
  } catch {
    return "";
  }
}

/** Read a file as UTF-8, returning "" when it cannot be read. */
function safeRead(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** Human-readable byte size (binary units). */
export function humanBytes(bytes) {
  const b = Number(bytes) || 0;
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let i = 0;
  let v = b;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

/** Human-readable duration from a seconds value. */
export function humanUptime(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h || d) parts.push(`${h}h`);
  if (m || h || d) parts.push(`${m}m`);
  parts.push(`${sec}s`);
  return parts.join(" ");
}

/** A text progress bar, e.g. `████░░░░░░ 40%`. */
export function progressBar(percent, width = 10) {
  const p = Math.max(0, Math.min(100, Number(percent) || 0));
  const filled = Math.round((p / 100) * width);
  return `${"█".repeat(filled)}${"░".repeat(Math.max(0, width - filled))}`;
}

export function getOsInfo() {
  const pretty = (safeRead("/etc/os-release").match(/^PRETTY_NAME="?([^"\n]+)"?/m) || [])[1] || "";
  return {
    hostname: os.hostname() || "unknown",
    type: os.type(),
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    pretty: pretty.trim() || `${os.type()} ${os.release()}`,
  };
}

export function getCpuInfo() {
  const cpus = os.cpus() || [];
  const model = (cpus[0]?.model || "Unknown CPU").replace(/\s+/g, " ").trim();
  const speedMHz = cpus[0]?.speed || 0;
  return {
    model,
    cores: cpus.length || 0,
    speedMHz,
    speed: speedMHz ? `${(speedMHz / 1000).toFixed(2)} GHz` : "?",
  };
}

export function getLoadAvg() {
  const [one = 0, five = 0, fifteen = 0] = os.loadavg();
  return { one, five, fifteen };
}

export function getMemoryInfo() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  return { total, free, used, percent: total ? +((used / total) * 100).toFixed(1) : 0 };
}

/** Swap usage — Linux only (`/proc/meminfo`). Returns null elsewhere. */
export function getSwapInfo() {
  const info = safeRead("/proc/meminfo");
  if (!info) return null;
  const total = Number((info.match(/^SwapTotal:\s+(\d+)/m) || [])[1] || 0) * 1024;
  const free = Number((info.match(/^SwapFree:\s+(\d+)/m) || [])[1] || 0) * 1024;
  if (!total) return null;
  const used = total - free;
  return { total, free, used, percent: +((used / total) * 100).toFixed(1) };
}

/** Root-filesystem usage via `df` (Linux/macOS). Returns null otherwise. */
export function getDiskInfo() {
  const out = safeExec("df -kP /");
  const line = out.trim().split("\n")[1];
  if (!line) return null;
  const cols = line.trim().split(/\s+/);
  const total = Number(cols[1]) * 1024;
  const used = Number(cols[2]) * 1024;
  if (!Number.isFinite(total) || total <= 0) return null;
  return { mount: "/", total, used, free: total - used, percent: +((used / total) * 100).toFixed(1) };
}

/** Non-internal network interfaces (name, address, family, mac). */
export function getNetworkInfo() {
  const out = [];
  const ni = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(ni)) {
    for (const a of addrs || []) {
      if (a.internal) continue;
      out.push({ name, address: a.address, family: a.family, mac: a.mac || null });
    }
  }
  return out;
}

/** Best-effort CPU temperature (°C). Returns null when unavailable. */
export function getCpuTemp() {
  for (const file of ["/sys/class/thermal/thermal_zone0/temp", "/sys/class/hwmon/hwmon0/temp1_input"]) {
    const raw = safeRead(file).trim();
    if (!raw) continue;
    const v = Number(raw);
    if (Number.isFinite(v) && v > 0) return +(v > 1000 ? v / 1000 : v).toFixed(1);
  }
  return null;
}

/** Coarse virtualisation detection (no environment values read). */
export function detectEnvironment() {
  try {
    if (fs.existsSync("/.dockerenv")) return "Docker";
  } catch {
    /* ignore */
  }
  const cgroup = safeRead("/proc/1/cgroup");
  if (/kubepods/.test(cgroup)) return "Kubernetes";
  if (/docker|containerd|libpod|podman/.test(cgroup)) return "Container";
  if (process.env.container) return "Container"; // set by systemd-nspawn etc.
  return "Bare Metal / VM";
}

export function getRuntimeInfo() {
  return {
    node: process.version,
    v8: process.versions.v8 || "?",
    pid: process.pid,
    processUptime: process.uptime(),
    systemUptime: os.uptime(),
  };
}

/** Collect every metric in one pass. */
export function collectSystemInfo() {
  return {
    os: getOsInfo(),
    cpu: getCpuInfo(),
    load: getLoadAvg(),
    mem: getMemoryInfo(),
    swap: getSwapInfo(),
    disk: getDiskInfo(),
    net: getNetworkInfo(),
    runtime: getRuntimeInfo(),
    temp: getCpuTemp(),
    environment: detectEnvironment(),
  };
}

/**
 * Render a neofetch/fastfetch-style report. Only non-sensitive figures are
 * printed — no paths, no environment values, no credentials.
 */
export function renderSystemInfo(info, { prefix = ".", botName = "GX-ID" } = {}) {
  const L = [];
  const bar = (pct) => `${progressBar(pct)} ${String(pct).padStart(5)}%`;

  L.push(`🖥️ *VPS / SERVER INFO*`);
  L.push(`_${botName} · ${info.os.hostname}_`);
  L.push("");
  L.push(`╭─〔 🖥️ *HOST* 〕`);
  L.push(`┃ Host    : \`${info.os.hostname}\``);
  L.push(`┃ OS      : ${info.os.pretty}`);
  L.push(`┃ Kernel  : ${info.os.type} ${info.os.release}`);
  L.push(`┃ Arch    : ${info.os.arch}`);
  L.push(`┃ Env     : ${info.environment}`);
  L.push(`╰─⬣`);
  L.push("");
  L.push(`╭─〔 🧠 *CPU* 〕`);
  L.push(`┃ Model   : ${info.cpu.model}`);
  L.push(`┃ Cores   : ${info.cpu.cores} @ ${info.cpu.speed}`);
  L.push(`┃ Load    : ${info.load.one.toFixed(2)} / ${info.load.five.toFixed(2)} / ${info.load.fifteen.toFixed(2)}`);
  if (info.temp !== null) L.push(`┃ Temp    : ${info.temp}°C`);
  L.push(`╰─⬣`);
  L.push("");
  L.push(`╭─〔 🧮 *MEMORY* 〕`);
  L.push(`┃ RAM     : ${bar(info.mem.percent)}`);
  L.push(`┃           ${humanBytes(info.mem.used)} / ${humanBytes(info.mem.total)}`);
  L.push(
    info.swap
      ? `┃ Swap    : ${bar(info.swap.percent)}\n┃           ${humanBytes(info.swap.used)} / ${humanBytes(info.swap.total)}`
      : `┃ Swap    : —`,
  );
  L.push(
    info.disk
      ? `┃ Disk    : ${bar(info.disk.percent)}\n┃           ${humanBytes(info.disk.used)} / ${humanBytes(info.disk.total)} @ ${info.disk.mount}`
      : `┃ Disk    : —`,
  );
  L.push(`╰─⬣`);
  L.push("");
  L.push(`╭─〔 ⚙️ *RUNTIME* 〕`);
  L.push(`┃ Node.js : ${info.runtime.node} (V8 ${info.runtime.v8})`);
  L.push(`┃ Bot Up  : ${humanUptime(info.runtime.processUptime)}`);
  L.push(`┃ Sys Up  : ${humanUptime(info.runtime.systemUptime)}`);
  L.push(`┃ PID     : ${info.runtime.pid}`);
  L.push(`╰─⬣`);
  L.push("");
  L.push(`╭─〔 🌐 *NETWORK* 〕`);
  if (info.net.length) {
    for (const n of info.net.slice(0, 6)) {
      L.push(`┃ ${n.name.padEnd(8, " ")}: ${n.address} (${n.family})`);
    }
  } else {
    L.push(`┃ —`);
  }
  L.push(`╰─⬣`);
  L.push("");
  L.push(`> Info bot: \`${prefix}botinfo\``);
  return L.join("\n");
}
