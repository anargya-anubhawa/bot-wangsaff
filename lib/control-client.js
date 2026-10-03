/**
 * GX-ID — control console (client)
 *
 * An interactive UI that connects to a RUNNING bot over the local control
 * socket (`lib/control-server.js`) and drives it from its own terminal:
 *
 *   1. Send Message  — pick a group / private chat and chat with it; the chat's
 *                      incoming messages are streamed in.
 *   2. Broadcast     — send one message to all registered groups or a subset.
 *   3. Restart bot   — relaunch the bot.
 *   4. Stop bot      — shut the bot down.
 *   5. Detach        — close this console (the bot keeps running).
 *
 * Because the console runs in its OWN process, the bot's normal log output is
 * untouched: the bot prints plain logs as always, and this client receives a
 * copy of those logs (plus the selected chat's conversation) over the socket
 * and renders them above a persistent footer showing live status.
 *
 * Run it with `npm run console` (or `node console.js`).
 */
import net from "net";
import readline from "readline";
import chalk from "chalk";
import { ConsoleFrame, shortJid } from "./console-shared.js";
import { controlPath, formatDuration, formatMemory } from "./control-utils.js";

/** Lines that leave the current chat session and return to the menu. */
const BACK = new Set(["/back", "/menu", "/exit", "..", "back"]);

const TAG_COLORS = {
  INFO: chalk.cyanBright,
  SUCCESS: chalk.greenBright,
  WARN: chalk.yellowBright,
  ERROR: chalk.redBright,
  COMMAND: chalk.magentaBright,
  PLUGIN: chalk.blueBright,
  GROUP: chalk.green,
  DATABASE: chalk.hex("#c084fc"),
  API: chalk.hex("#38bdf8"),
  CONNECTION: chalk.hex("#fb923c"),
  SYSTEM: chalk.gray,
  DEBUG: chalk.dim,
};

function groupLabel(entry) {
  return entry.alias ? `${entry.name} (${entry.alias})` : entry.name;
}

export class ControlConsole {
  /**
   * @param {object} [options]
   * @param {NodeJS.ReadStream} [options.input]
   * @param {NodeJS.WriteStream} [options.output]
   * @param {string} [options.path]   control socket path (defaults to the bot's)
   */
  constructor(options = {}) {
    this.input = options.input || process.stdin;
    this.output = options.output || process.stdout;
    this.path = options.path || controlPath();

    this.frame = new ConsoleFrame(this.output);
    this.socket = null;
    this.rl = null;
    this._buffer = "";
    this._seq = 0;
    this._pending = new Map();
    this._pendingLine = null;
    this._stopped = false;
    this._activeChat = null;
    this._targets = [];
    this._status = null;
    this._statusTimer = null;
    this._everConnected = false;
  }

  /* ───────────────────────────── lifecycle ───────────────────────────── */

  async start() {
    this.frame.setFooter(this._footerLines());
    this.frame.enter();

    const connected = await this._connect();
    if (!connected) {
      this.frame.leave();
      this.output.write(
        `  ${chalk.redBright("✖")} tidak bisa terhubung ke bot di ${chalk.whiteBright(this.path)}\n` +
          `  ${chalk.gray("Pastikan bot sedang berjalan, lalu coba lagi.")}\n`,
      );
      return this;
    }

    this.rl = readline.createInterface({
      input: this.input,
      output: this.output,
      terminal: Boolean(this.output.isTTY),
      historySize: 200,
    });
    this.rl.on("line", (line) => this._onLine(line));
    this.rl.on("close", () => {
      this._stopped = true;
      this._resolvePending("");
    });
    this.rl.on("SIGINT", () => this.stop());

    this._logAbove(`  ${chalk.greenBright("✔")} terhubung ke bot  ${chalk.gray(this.path)}`);
    this._logAbove(`  ${chalk.gray("ketik angka menu lalu Enter · Ctrl+C untuk keluar")}`);
    this._logAbove("");

    this._refreshStatus().catch(() => {});
    this._statusTimer = setInterval(() => this._refreshStatus().catch(() => {}), 2000);
    this._run().catch((error) => this._logAbove(`  ${chalk.redBright("✖")} ${error?.message || error}`));
    return this;
  }

  stop() {
    if (this._stopped) return this;
    this._stopped = true;
    if (this._statusTimer) clearInterval(this._statusTimer);
    this._statusTimer = null;
    try {
      this.rl?.close();
    } catch {
      /* ignore */
    }
    try {
      this.socket?.end();
    } catch {
      /* ignore */
    }
    this.frame.leave();
    return this;
  }

  _connect() {
    return new Promise((resolve) => {
      const socket = net.connect(this.path);
      this.socket = socket;
      socket.setEncoding("utf8");
      let settled = false;
      socket.once("connect", () => {
        settled = true;
        this._everConnected = true;
        resolve(true);
      });
      socket.once("error", () => {
        settled = true;
        resolve(false);
      });
      socket.on("data", (chunk) => this._onData(chunk));
      socket.on("close", () => {
        // Only warn when a previously-established connection drops.
        if (!this._everConnected || this._stopped) return;
        this._logAbove(`  ${chalk.yellowBright("•")} koneksi ke bot terputus.`);
        this.stop();
      });
    });
  }

  async _run() {
    while (!this._stopped) {
      const action = await this._mainMenu();
      if (this._stopped) break;
      if (action === "1") await this._sendMessageFlow();
      else if (action === "2") await this._broadcastFlow();
      else if (action === "3") return this._restart();
      else if (action === "4") return this._shutdown();
      else if (action === "5") return this.stop();
    }
  }

  /* ───────────────────────────── socket protocol ───────────────────────────── */

  _send(obj) {
    if (!this.socket || this.socket.destroyed) return;
    try {
      this.socket.write(`${JSON.stringify(obj)}\n`);
    } catch {
      /* ignore */
    }
  }

  _rpc(type, payload = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this._seq;
      const timer = setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new Error(`${type} timeout`));
        }
      }, 15000);
      this._pending.set(id, { resolve, reject, timer });
      this._send({ id, type, ...payload });
    });
  }

  _onData(chunk) {
    this._buffer += chunk;
    let index;
    while ((index = this._buffer.indexOf("\n")) >= 0) {
      const line = this._buffer.slice(0, index);
      this._buffer = this._buffer.slice(index + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id != null && this._pending.has(message.id)) {
        const { resolve, reject, timer } = this._pending.get(message.id);
        this._pending.delete(message.id);
        clearTimeout(timer);
        if (message.ok === false) reject(new Error(message.error || "request failed"));
        else resolve(message);
      } else if (message.event) {
        this._onEvent(message);
      }
    }
  }

  _onEvent(message) {
    switch (message.event) {
      case "hello":
        this._logAbove(`  ${chalk.gray(`bot ${message.bot || "GX-ID"} v${message.version || "?"}`)}`);
        break;
      case "log": {
        const entry = message.entry || {};
        const paint = TAG_COLORS[entry.tag] || chalk.white;
        this._logAbove(`  ${paint(`[${entry.tag || "LOG"}]`)} ${entry.message ?? ""}`);
        break;
      }
      case "incoming": {
        const info = message.message || {};
        const who = info.fromMe ? "you" : info.pushName || shortJid(info.sender) || "unknown";
        const body = info.body || (info.type ? `[${info.type}]` : "");
        const paint = info.fromMe ? chalk.magentaBright : chalk.cyanBright;
        this._logAbove(`  ${paint(who)} ${chalk.gray("›")} ${body}`);
        break;
      }
      case "broadcast-progress": {
        const label = message.ok ? chalk.greenBright("✔") : chalk.redBright("✖");
        this._logAbove(`  ${label} ${shortJid(message.jid)} ${chalk.gray(`(${message.sent}✓ ${message.failed}✗)`)}`);
        break;
      }
      default:
        break;
    }
  }

  /* ───────────────────────────── status footer ───────────────────────────── */

  _clock() {
    const now = new Date();
    return [now.getHours(), now.getMinutes(), now.getSeconds()]
      .map((n) => String(n).padStart(2, "0"))
      .join(":");
  }

  async _refreshStatus() {
    try {
      const reply = await this._rpc("status");
      this._status = reply.status || null;
    } catch {
      /* keep previous */
    }
    this._refreshFooter();
  }

  _statusLine() {
    const s = this._status;
    const time = chalk.whiteBright(`🕐 ${this._clock()}`);
    const uptime = chalk.gray(`⏱ ${formatDuration(s?.uptime || 0)}`);
    const ping =
      s?.ping == null
        ? chalk.gray("📶 —")
        : chalk[s.ping < 150 ? "greenBright" : s.ping < 400 ? "yellowBright" : "redBright"](
            `📶 ${Math.round(s.ping)}ms`,
          );
    const mem = chalk.gray(`🧠 ${formatMemory(s?.memory || process.memoryUsage().rss)}`);
    const groups = chalk.gray(`👥 ${s?.groups ?? 0} group`);
    const online = s?.connected ? chalk.greenBright("● online") : chalk.yellow("○ offline");
    return `  ${time} ${chalk.gray("·")} ${uptime} ${chalk.gray("·")} ${ping} ${chalk.gray("·")} ${mem} ${chalk.gray("·")} ${groups} ${chalk.gray("·")} ${online}`;
  }

  _menuLine() {
    if (this._activeChat) {
      return `  ${chalk.gray("chat:")} ${chalk.cyanBright(this._activeChat)}  ${chalk.gray("· type to send ·")} ${chalk.whiteBright("/back")} ${chalk.gray("to leave")}`;
    }
    return (
      `  ${chalk.cyanBright("[1]")} Send ${chalk.gray("·")} ` +
      `${chalk.cyanBright("[2]")} Broadcast ${chalk.gray("·")} ` +
      `${chalk.cyanBright("[3]")} Restart ${chalk.gray("·")} ` +
      `${chalk.cyanBright("[4]")} Stop ${chalk.gray("·")} ` +
      `${chalk.cyanBright("[5]")} Detach`
    );
  }

  _footerLines() {
    return [
      `  ${chalk.cyanBright("─".repeat(Math.min(52, (this.frame.cols || 80) - 4)))}`,
      this._statusLine(),
      this._menuLine(),
    ];
  }

  _refreshFooter() {
    if (this._stopped) return;
    // Redrawing the footer uses cursor save/restore, so the prompt line is
    // untouched and does not need repainting.
    this.frame.setFooter(this._footerLines());
  }

  /* ───────────────────────────── screens ───────────────────────────── */

  _section(title) {
    this._logAbove("");
    this._logAbove(`  ${chalk.cyanBright("╭─")} ${chalk.whiteBright.bold(title)}`);
  }

  _prompt() {
    return `  ${chalk.cyanBright("›")} `;
  }

  async _mainMenu() {
    this._refreshFooter();
    const answer = (await this._ask(this._prompt())).trim().toLowerCase();
    if (["1", "2", "3", "4", "5"].includes(answer)) return answer;
    if (answer === "") return null;
    if (answer === "q") return "5";
    this._logAbove(`  ${chalk.redBright("✖")} pilihan tidak valid — masukkan 1–5.`);
    return null;
  }

  /* ───────────────────────────── send message ───────────────────────────── */

  async _sendMessageFlow() {
    const target = await this._pickTarget();
    if (target) await this._chatSession(target);
  }

  async _pickTarget() {
    let targets = [];
    try {
      const reply = await this._rpc("targets");
      targets = reply.targets || [];
    } catch (error) {
      this._logAbove(`  ${chalk.redBright("✖")} ${error?.message || error}`);
      return null;
    }
    this._targets = targets;

    this._section("KIRIM PESAN · pilih tujuan");
    if (targets.length) {
      targets.forEach((entry, index) => {
        const key = chalk[entry.registered ? "greenBright" : "cyanBright"](String(index + 1).padStart(2));
        const hint = entry.registered ? chalk.gray("registered") : "";
        this._logAbove(`  ${key}  ${chalk.whiteBright(groupLabel(entry))}${hint ? `  ${hint}` : ""}`);
      });
    } else {
      this._logAbove(`  ${chalk.gray("• belum ada grup — daftarkan grup atau pakai PC")}`);
    }
    this._logAbove(`  ${chalk.cyanBright("p")}  ${chalk.whiteBright("Private chat (PC)")}  ${chalk.gray("ketik nomor telepon")}`);
    this._logAbove(`  ${chalk.gray("0")}  ${chalk.gray("Kembali")}`);
    this._logAbove("");

    const answer = (await this._ask(this._prompt())).trim().toLowerCase();
    if (answer === "" || answer === "0" || answer === "b") return null;

    if (answer === "p") {
      const raw = (await this._ask(`  ${chalk.gray("Nomor telepon (cth. 6281234567890):")} `)).trim();
      let num = raw.replace(/[^0-9]/g, "");
      if (num.startsWith("0")) num = `62${num.slice(1)}`;
      if (num.length < 8) {
        this._logAbove(`  ${chalk.redBright("✖")} nomor tidak valid.`);
        return null;
      }
      const jid = `${num}@s.whatsapp.net`;
      return { jid, name: shortJid(jid), isGroup: false };
    }

    const index = Number(answer) - 1;
    const entry = Number.isInteger(index) ? targets[index] : undefined;
    if (!entry) {
      this._logAbove(`  ${chalk.redBright("✖")} pilihan tidak valid.`);
      return null;
    }
    return { jid: entry.jid, name: groupLabel(entry), isGroup: true };
  }

  async _chatSession(target) {
    this._activeChat = target.jid;
    this._section(`CHAT · ${target.name}`);
    this._logAbove(`  ${chalk.gray("ketik pesan untuk mengirim · '/back' untuk kembali")}`);
    this._logAbove("");
    this._refreshFooter();

    try {
      await this._rpc("watch", { jid: target.jid });
    } catch {
      /* ignore */
    }

    for (;;) {
      const line = await this._ask(`  ${chalk.cyanBright(target.name)} ${chalk.gray("›")} `);
      if (this._stopped) break;
      const text = line.trim();
      if (!text) continue;
      if (BACK.has(text.toLowerCase())) break;
      try {
        await this._rpc("send", { jid: target.jid, text });
      } catch (error) {
        this._logAbove(`  ${chalk.redBright("✖")} ${error?.message || error}`);
      }
    }

    try {
      await this._rpc("watch", { jid: null });
    } catch {
      /* ignore */
    }
    this._activeChat = null;
    this._logAbove(`  ${chalk.gray("• keluar dari chat.")}`);
    this._refreshFooter();
  }

  /* ───────────────────────────── broadcast ───────────────────────────── */

  async _broadcastFlow() {
    let targets = [];
    try {
      const reply = await this._rpc("targets");
      targets = (reply.targets || []).filter((entry) => entry.registered);
    } catch (error) {
      this._logAbove(`  ${chalk.redBright("✖")} ${error?.message || error}`);
      return;
    }

    this._section("BROADCAST");
    if (!targets.length) {
      this._logAbove(`  ${chalk.gray("• belum ada grup terdaftar.")}`);
      await this._ask(`  ${chalk.gray("Enter untuk lanjut…")} `);
      return;
    }

    this._logAbove(`  ${chalk.cyanBright("1")}  ${chalk.whiteBright("Semua grup terdaftar")}  ${chalk.gray(`(${targets.length})`)}`);
    this._logAbove(`  ${chalk.cyanBright("2")}  ${chalk.whiteBright("Pilih grup")}  ${chalk.gray("checkbox")}`);
    this._logAbove(`  ${chalk.gray("0")}  ${chalk.gray("Kembali")}`);
    this._logAbove("");

    const answer = (await this._ask(this._prompt())).trim().toLowerCase();
    if (answer === "1") {
      const text = await this._askMessage();
      if (text) await this._broadcastSend(targets.map((t) => t.jid), text);
    } else if (answer === "2") {
      await this._broadcastSelect(targets);
    }
  }

  async _broadcastSelect(targets) {
    const selected = new Set();
    for (;;) {
      this._section("BROADCAST · pilih grup");
      targets.forEach((entry, index) => {
        const on = selected.has(entry.jid);
        const mark = on ? chalk.greenBright("[x]") : chalk.gray("[ ]");
        const key = chalk[on ? "greenBright" : "gray"](String(index + 1).padStart(2));
        this._logAbove(`  ${key} ${mark} ${on ? chalk.whiteBright(groupLabel(entry)) : chalk.gray(groupLabel(entry))}`);
      });
      this._logAbove(`  ${chalk.gray("angka toggle · 'a' semua · 'n' kosong · 's' kirim · 'b' kembali")}`);
      this._logAbove("");

      const answer = (await this._ask(this._prompt())).trim().toLowerCase();
      if (answer === "b" || answer === "") return;
      if (answer === "a") {
        targets.forEach((entry) => selected.add(entry.jid));
        continue;
      }
      if (answer === "n") {
        selected.clear();
        continue;
      }
      if (answer === "s") {
        if (!selected.size) {
          this._logAbove(`  ${chalk.redBright("✖")} belum ada yang dipilih.`);
          continue;
        }
        const text = await this._askMessage();
        if (!text) continue;
        await this._broadcastSend([...selected], text);
        return;
      }

      let changed = false;
      for (const token of answer.split(/[\s,]+/)) {
        const n = Number(token);
        if (!Number.isInteger(n) || n < 1 || n > targets.length) continue;
        const jid = targets[n - 1].jid;
        if (selected.has(jid)) selected.delete(jid);
        else selected.add(jid);
        changed = true;
      }
      if (!changed) this._logAbove(`  ${chalk.redBright("✖")} pilihan tidak valid.`);
    }
  }

  async _askMessage() {
    const text = (await this._ask(`  ${chalk.gray("Pesan (kosong = batal):")} `)).trim();
    if (!text) {
      this._logAbove(`  ${chalk.gray("• dibatalkan.")}`);
      return null;
    }
    return text;
  }

  async _broadcastSend(jids, text) {
    try {
      const reply = await this._rpc("broadcast", { jids, text });
      this._logAbove("");
      this._logAbove(`  ${chalk.gray(`• selesai — ${reply.sent} terkirim, ${reply.failed} gagal.`)}`);
    } catch (error) {
      this._logAbove(`  ${chalk.redBright("✖")} ${error?.message || error}`);
    }
    await this._ask(`  ${chalk.gray("Enter untuk lanjut…")} `);
  }

  /* ───────────────────────────── restart / stop ───────────────────────────── */

  async _restart() {
    this._logAbove("");
    this._logAbove(`  ${chalk.gray("• meminta bot restart…")}`);
    try {
      await this._rpc("restart");
    } catch {
      /* the socket may drop as the bot restarts */
    }
    this._logAbove(`  ${chalk.yellowBright("• bot sedang restart — jalankan console ini lagi setelah bot online.")}`);
    this.stop();
  }

  async _shutdown() {
    const confirm = (await this._ask(`  ${chalk.redBright("Yakin hentikan bot? (y/N)")} `)).trim().toLowerCase();
    if (confirm !== "y" && confirm !== "yes") {
      this._logAbove(`  ${chalk.gray("• dibatalkan.")}`);
      return;
    }
    this._logAbove(`  ${chalk.gray("• meminta bot berhenti…")}`);
    try {
      await this._rpc("shutdown");
    } catch {
      /* ignore */
    }
    this.stop();
  }

  /* ───────────────────────────── readline plumbing ───────────────────────────── */

  _ask(question) {
    return new Promise((resolve) => {
      if (this._stopped) return resolve("");
      this._pendingLine = resolve;
      this.frame.promptPosition();
      this.rl.setPrompt(question);
      this.rl.prompt();
    });
  }

  _resolvePending(value) {
    if (this._pendingLine) {
      const resolve = this._pendingLine;
      this._pendingLine = null;
      resolve(value);
    }
  }

  _onLine(line) {
    if (this._pendingLine) {
      const resolve = this._pendingLine;
      this._pendingLine = null;
      resolve(line);
    }
  }

  /** Print a line into the scrollable log area (above the footer). */
  _logAbove(text) {
    if (this._stopped) return;
    this.frame.log(text);
    if (this._pendingLine && this.frame.active && this.rl) {
      try {
        this.rl.prompt(true);
      } catch {
        /* ignore */
      }
    }
  }
}

/** Start the control console client. */
export function startControlConsole(options = {}) {
  return new ControlConsole(options).start();
}
