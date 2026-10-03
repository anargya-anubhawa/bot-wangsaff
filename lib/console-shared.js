/**
 * GX-ID — console shared primitives
 *
 * Rendering helpers and `.env` utilities shared by the pre-boot control panel
 * (`lib/console-ui.js`) and the separate control console client
 * (`lib/control-client.js`).
 *
 * A `Terminal` bundles a swappable output sink with the small set of drawing
 * helpers both interfaces need, so each screen can render into an injected
 * stream (used by tests) instead of hard-wiring `process.stdout`.
 */
import fs from "fs";
import path from "path";
import { banner, chalk } from "./logger.js";

/** Horizontal rule used by the boxed headers. */
export const BAR = "─".repeat(52);

/** Keys whose value should never be echoed back in full. */
export const SECRET_RE = /(TOKEN|SECRET|PASSWORD|PASS|APIKEY|API_KEY|PRIVATE_KEY|CREDENTIAL)/i;

export class Terminal {
  /**
   * @param {object} [options]
   * @param {NodeJS.ReadStream} [options.input]  stdin (default `process.stdin`)
   * @param {NodeJS.WriteStream} [options.output] stdout (default `process.stdout`)
   */
  constructor(options = {}) {
    this.input = options.input || process.stdin;
    this.output = options.output || process.stdout;
    this.sink = this.output;
  }

  /** True only when both ends are a real terminal. */
  get isTTY() {
    return Boolean(this.input?.isTTY && this.output?.isTTY);
  }

  /** Redirect all rendering to another stream (tests). */
  use(output) {
    if (output) this.sink = output;
    return this;
  }

  write(text = "") {
    this.sink.write(`${text}\n`);
  }

  clearScreen() {
    if (!this.sink.isTTY) return;
    try {
      // Clear visible screen + scrollback, then move the cursor home.
      this.sink.write("\x1b[2J\x1b[3J\x1b[H");
    } catch {
      /* ignore */
    }
  }

  header(title) {
    this.write("");
    this.write(`  ${chalk.cyanBright(`╭${BAR}`)}`);
    this.write(`  ${chalk.cyanBright("│")}  ${chalk.whiteBright.bold(title)}`);
    this.write(`  ${chalk.cyanBright(`╰${BAR}`)}`);
    this.write("");
  }

  item(key, icon, label, hint) {
    this.write(
      `  ${chalk.cyanBright(`[${key}]`)}  ${icon}  ${chalk.whiteBright.bold(label.padEnd(15))} ${chalk.gray(hint)}`,
    );
  }

  /** A numbered row for list menus (settings, groups, chats). */
  row(number, label, hint = "", color = chalk.cyanBright) {
    const key = String(number).padStart(2);
    this.write(`  ${color(key)}  ${chalk.whiteBright(label)}${hint ? `  ${chalk.gray(hint)}` : ""}`);
  }

  ok(message) {
    this.write(`  ${chalk.greenBright("✔")} ${message}`);
  }

  fail(message) {
    this.write(`  ${chalk.redBright("✖")} ${message}`);
  }

  note(message) {
    this.write(`  ${chalk.gray(`• ${message}`)}`);
  }

  /** Capture the logger banner as an array of lines (without printing). */
  bannerLines(info) {
    const lines = [];
    const original = console.log;
    console.log = (...args) => lines.push(args.join(" "));
    try {
      banner(info);
    } finally {
      console.log = original;
    }
    return lines;
  }

  /** Render the logger banner into this terminal's sink. */
  printBanner(info) {
    for (const line of this.bannerLines(info)) this.sink.write(`${line}\n`);
  }
}

/* ─────────────────────────── ANSI helpers ─────────────────────────── */

const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Visible (printed) length of a string, ignoring ANSI colour codes. */
export function visibleLength(str) {
  return String(str).replace(ANSI_RE, "").length;
}

/** Truncate a string to `max` visible characters, keeping ANSI codes intact. */
export function truncateAnsi(str, max) {
  const text = String(str);
  if (max <= 0 || visibleLength(text) <= max) return text;
  let out = "";
  let count = 0;
  for (let i = 0; i < text.length; ) {
    if (text[i] === "\x1b") {
      const match = /^\x1b\[[0-9;]*m/.exec(text.slice(i));
      if (match) {
        out += match[0];
        i += match[0].length;
        continue;
      }
    }
    if (count >= max - 1) {
      out += "…";
      break;
    }
    out += text[i];
    i += 1;
    count += 1;
  }
  return out;
}

/* ─────────────────────────── fixed footer frame ─────────────────────────── */

/**
 * A persistent footer ("control bar") pinned to the bottom of the terminal,
 * with a scrollable log area above it.
 *
 * It reserves the bottom `footer.length` lines by setting a DECSTBM scroll
 * region on the lines above them. Log lines are written at the bottom of that
 * region, so they scroll upward while the footer never moves. The input prompt
 * lives on the last line of the scroll region (just above the footer), so a
 * submitted line scrolls up into the log area on its own — giving a natural
 * transcript with no extra echo handling.
 *
 * Everything is a no-op on a non-TTY stream, so headless runs and tests simply
 * fall back to plain line output.
 */
export class ConsoleFrame {
  /**
   * @param {NodeJS.WriteStream} output  the stream to render into
   * @param {object} [options]
   * @param {string[]} [options.footer]  initial footer lines (bottom of screen)
   */
  constructor(output, options = {}) {
    this.output = output;
    this.active = false;
    this.footer = Array.isArray(options.footer) ? options.footer : [];
    this._onResize = null;
    this._regionBottom = null;
  }

  get isTTY() {
    return Boolean(this.output?.isTTY);
  }

  get rows() {
    return this.output?.rows || 24;
  }

  get cols() {
    return this.output?.columns || 80;
  }

  get footerHeight() {
    return this.footer.length;
  }

  /** The last line of the scroll region — also the input prompt line. */
  get promptRow() {
    return Math.max(1, this.rows - this.footerHeight);
  }

  /** Activate the frame: reserve the footer and position the cursor. */
  enter() {
    if (!this.isTTY || this.active) return this;
    this.active = true;
    this._setRegion();
    this._drawFooter();
    this.promptPosition();
    if (typeof this.output.on === "function") {
      this._onResize = () => this.refresh();
      this.output.on("resize", this._onResize);
    }
    return this;
  }

  /** Deactivate the frame and restore the terminal's normal scroll region. */
  leave() {
    if (this._onResize && typeof this.output.off === "function") {
      this.output.off("resize", this._onResize);
    }
    this._onResize = null;
    if (this.active && this.isTTY) {
      try {
        this.output.write("\x1b[r"); // reset scroll region
      } catch {
        /* ignore */
      }
    }
    this.active = false;
    this._regionBottom = null;
    return this;
  }

  /** Replace the footer contents (status + menu) and redraw it. */
  setFooter(lines) {
    this.footer = Array.isArray(lines) ? lines : [lines];
    if (this.active) {
      this._setRegion();
      this._drawFooter();
    }
    return this;
  }

  /** Re-apply the scroll region and redraw the footer (e.g. after a resize). */
  refresh() {
    if (!this.active) return this;
    this._setRegion();
    this._drawFooter();
    return this;
  }

  /** Clear the prompt line and move the cursor there (call before `rl.prompt`). */
  promptPosition() {
    if (!this.active) return this;
    try {
      this.output.write(`\x1b[${this.promptRow};1H\x1b[2K`);
    } catch {
      /* ignore */
    }
    return this;
  }

  /**
   * Print text into the scrollable area above the footer. Multi-line text is
   * scrolled line by line so the footer stays put.
   */
  log(text) {
    const str = String(text ?? "");
    if (!this.active) {
      this.output.write(`${str}\n`);
      return this;
    }
    const bottom = this.promptRow;
    try {
      this.output.write(`\x1b[${bottom};1H\x1b[2K`);
      for (const line of str.split("\n")) this.output.write(`${line}\n`);
    } catch {
      this.output.write(`${str}\n`);
    }
    return this;
  }

  _setRegion() {
    const bottom = this.promptRow;
    // Only issue DECSTBM when the region actually changes: the sequence can move
    // the cursor home on some terminals, which would flicker on every tick.
    if (this._regionBottom === bottom) return;
    this._regionBottom = bottom;
    try {
      this.output.write(`\x1b[1;${bottom}r`);
    } catch {
      /* ignore */
    }
  }

  _drawFooter() {
    if (!this.isTTY) return;
    const start = this.promptRow + 1;
    try {
      // Save/restore the cursor so redrawing the footer never disturbs the
      // prompt line (and never emits a stray prompt of its own).
      this.output.write("\x1b[s");
      for (let i = 0; i < this.footer.length; i++) {
        this.output.write(`\x1b[${start + i};1H\x1b[2K${truncateAnsi(this.footer[i], this.cols)}`);
      }
      this.output.write("\x1b[u");
    } catch {
      /* ignore */
    }
  }
}

/* ─────────────────────────────── .env helpers ─────────────────────────────── */

/**
 * Parse a `.env` file into its raw lines plus every `KEY=VALUE` entry.
 * Comments, blank lines and unknown syntax are preserved untouched.
 */
export function parseEnvFile(file) {
  if (!fs.existsSync(file)) return { lines: [], entries: [] };
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const entries = [];
  lines.forEach((raw, index) => {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(raw);
    if (match) entries.push({ key: match[1], value: match[2], line: index });
  });
  return { lines, entries };
}

/** Update `KEY` in place, or append it when missing. Formatting is preserved. */
export function setEnvValue(file, key, value) {
  const { lines, entries } = parseEnvFile(file);
  const existing = entries.find((entry) => entry.key === key);
  const line = `${key}=${value}`;
  if (existing) {
    lines[existing.line] = line;
  } else {
    if (lines.length && lines[lines.length - 1] !== "") lines.push("");
    lines.push(line);
  }
  fs.writeFileSync(file, lines.join("\n"));
}

export function mask(value) {
  if (!value) return chalk.gray("(empty)");
  if (value.length <= 8) return "•".repeat(value.length);
  return `${value.slice(0, 4)}${"•".repeat(Math.min(12, value.length - 8))}${value.slice(-4)}`;
}

export function displayValue(key, value) {
  if (SECRET_RE.test(key)) return chalk.yellow(mask(value));
  if (!value) return chalk.gray("(empty)");
  return chalk.whiteBright(value);
}

/** Recursive size of a file or directory, humanised. */
export function dirSize(target) {
  let total = 0;
  const stack = [target];
  while (stack.length) {
    const current = stack.pop();
    let stat;
    try {
      stat = fs.statSync(current);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(current)) stack.push(path.join(current, child));
    } else {
      total += stat.size;
    }
  }
  if (total < 1024) return `${total} B`;
  if (total < 1024 * 1024) return `${(total / 1024).toFixed(1)} KB`;
  return `${(total / 1024 / 1024).toFixed(2)} MB`;
}

/** Short, human label for a chat JID. */
export function shortJid(jid) {
  return String(jid || "").split("@")[0].split(":")[0];
}
