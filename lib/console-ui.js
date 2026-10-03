/**
 * GX-ID — interactive boot console
 *
 * Shown when `npm start` runs inside an interactive terminal. It offers:
 *   1. Start Bot        — run the normal boot sequence
 *   2. Clear Session    — wipe the WhatsApp auth state (forces a re-link)
 *   3. Settings         — view / edit every value inside `.env`
 *   4. Exit             — quit without starting the bot
 *
 * If the operator does nothing for `MENU_TIMEOUT` seconds (default 30) the bot
 * starts automatically, so an unattended launch is never left hanging. The
 * timeout is configurable from the Settings screen (persisted to `.env` as
 * `MENU_TIMEOUT`).
 *
 * When stdin/stdout is not a TTY (pm2, docker, CI, `node index.js | tee`, …) or
 * when `--no-menu` / `NO_MENU=1` is passed, the menu is skipped entirely and the
 * bot boots straight away, so headless deployments are never blocked.
 */
import fs from "fs";
import path from "path";
import readline from "readline";
import { chalk } from "./logger.js";
import {
  Terminal,
  parseEnvFile,
  setEnvValue,
  displayValue,
  dirSize,
} from "./console-shared.js";

const ROOT = process.cwd();
const ENV_PATH = path.join(ROOT, ".env");
const ENV_EXAMPLE = path.join(ROOT, ".env.example");

/** Default seconds of inactivity before the menu auto-starts the bot. */
export const DEFAULT_MENU_TIMEOUT = 30;

/** Read the configured menu timeout (seconds). `0` disables the timeout. */
export function getMenuTimeout() {
  const raw = Number(process.env.MENU_TIMEOUT);
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_MENU_TIMEOUT;
  return raw;
}

/* ─────────────────────────────── menu views ─────────────────────────────── */

const term = new Terminal();

function sessionFolder() {
  return process.env.SESSION_FOLDER || "session";
}

function sessionStatus() {
  const creds = path.join(ROOT, "storage", sessionFolder(), "creds.json");
  return fs.existsSync(creds) ? chalk.greenBright("● linked") : chalk.yellow("○ not linked");
}

/**
 * The value shown on the Timeout row. While the menu is waiting this is the
 * live countdown; otherwise it shows the configured timeout.
 */
function timeoutInfo(countdown = null) {
  const configured = getMenuTimeout();
  if (configured <= 0) return chalk.gray("disabled");
  if (countdown !== null && countdown >= 0) {
    return `${chalk.yellowBright.bold(`${countdown}s`)} ${chalk.gray("· auto-start, press a key to cancel")}`;
  }
  return chalk.cyanBright(`${configured}s`);
}

/**
 * Render the control panel.
 *
 * @param {number|null} [countdown] seconds left before the bot auto-starts, or
 *   `null` to show the configured timeout value.
 * @returns {number} how many lines sit between the Timeout row and the prompt,
 *   so the countdown can be updated in place (see `askWithTimeout`).
 */
function renderMain(countdown = null) {
  term.clearScreen();
  term.printBanner({
    name: process.env.BOT_NAME || "GX-ID",
    version: "1.0.0",
    mode: process.env.BOT_MODE || "public",
    owner: process.env.OWNER_NAME || "Owner",
  });
  term.header("CONTROL PANEL");
  term.write(`  ${chalk.gray("Session")} : ${sessionStatus()}`);
  term.write(`  ${chalk.gray("Mode")}    : ${chalk.cyanBright(process.env.BOT_MODE || "public")}`);
  term.write(`  ${chalk.gray("Timeout")} : ${timeoutInfo(countdown)}`);

  let offset = 0;
  term.write("");
  offset += 1;
  term.item("1", chalk.greenBright("▶"), "Start Bot", "connect the bot to WhatsApp");
  offset += 1;
  term.item("2", chalk.yellowBright("✖"), "Clear Session", "unlink & wipe the auth state");
  offset += 1;
  term.item("3", chalk.cyanBright("⚙"), "Settings", "view / edit .env values");
  offset += 1;
  term.item("4", chalk.redBright("⏻"), "Exit", "quit without starting");
  offset += 1;
  term.write("");
  offset += 1;
  return offset;
}

function renderSettings(entries) {
  term.clearScreen();
  term.header("SETTINGS · .env");
  if (!entries.length) {
    term.note("No .env found — press 'a' to create the first entry.");
  }
  entries.forEach((entry, index) => {
    const number = String(index + 1).padStart(2);
    term.write(
      `  ${chalk.cyanBright(number)}  ${chalk.whiteBright(entry.key.padEnd(24))} ${chalk.gray("=")} ${displayValue(entry.key, entry.value)}`,
    );
  });
  term.write("");
  term.write(`  ${chalk.gray("Enter a number to edit · 'a' to add a key · 'b' to go back")}`);
  term.write(`  ${chalk.gray("Tip: edit MENU_TIMEOUT to change the auto-start delay (seconds, 0 = off)")}`);
  term.write("");
}

/* ─────────────────────────────── actions ─────────────────────────────── */

async function settingsMenu(ask) {
  // Offer to seed `.env` from the example when it is missing.
  if (!fs.existsSync(ENV_PATH) && fs.existsSync(ENV_EXAMPLE)) {
    term.note("No .env found — creating one from .env.example…");
    try {
      fs.copyFileSync(ENV_EXAMPLE, ENV_PATH);
      term.ok(".env created from .env.example");
    } catch (error) {
      term.fail(`could not create .env: ${error?.message || error}`);
    }
    await ask(`  ${chalk.gray("Press Enter to continue…")} `);
  }

  for (;;) {
    const { entries } = parseEnvFile(ENV_PATH);
    renderSettings(entries);

    const answer = (await ask(`  ${chalk.cyanBright("›")} `)).trim().toLowerCase();

    if (answer === "b" || answer === "") return;

    if (answer === "a") {
      const key = (await ask(`  ${chalk.gray("New key name:")} `)).trim();
      if (!key) continue;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        term.fail("invalid key name (letters, digits and _ only).");
        continue;
      }
      const value = (await ask(`  ${chalk.gray(`${key} =`)} `)).trim();
      setEnvValue(ENV_PATH, key, value);
      process.env[key] = value;
      term.ok(`${key} saved ${chalk.gray("(applies on next start)")}`);
      continue;
    }

    const index = Number(answer) - 1;
    const entry = Number.isInteger(index) ? entries[index] : undefined;
    if (!entry) {
      term.fail("invalid choice.");
      continue;
    }

    term.write("");
    term.write(
      `  ${chalk.whiteBright(entry.key)} ${chalk.gray("=")} ${displayValue(entry.key, entry.value)}`,
    );
    const value = await ask(`  ${chalk.gray("New value (blank to cancel):")} `);
    if (value.trim() === "") {
      term.note("cancelled.");
      continue;
    }
    setEnvValue(ENV_PATH, entry.key, value.trim());
    process.env[entry.key] = value.trim();
    if (entry.key === "MENU_TIMEOUT") {
      term.ok(`MENU_TIMEOUT updated to ${value.trim()}s ${chalk.gray("(applies now)")}`);
    } else {
      term.ok(`${entry.key} updated ${chalk.gray("(applies on next start)")}`);
    }
  }
}

async function clearSession(ask) {
  const targets = [
    { label: path.join("storage", sessionFolder()), abs: path.join(ROOT, "storage", sessionFolder()) },
    { label: path.join("session", "jadibot"), abs: path.join(ROOT, "session", "jadibot") },
  ].filter((target) => fs.existsSync(target.abs));

  term.clearScreen();
  term.header("CLEAR SESSION");

  if (!targets.length) {
    term.note("nothing to clear — no session data was found.");
    await ask(`  ${chalk.gray("Press Enter to continue…")} `);
    return;
  }

  for (const target of targets) {
    term.write(`  ${chalk.yellowBright("•")} ${chalk.whiteBright(target.label)}  ${chalk.gray(dirSize(target.abs))}`);
  }
  term.write("");
  term.write(`  ${chalk.redBright("This unlinks the bot — you will need to re-scan the QR / re-pair.")}`);
  term.write("");

  const confirm = (await ask(`  ${chalk.gray("Confirm deletion? (y/N)")} `)).trim().toLowerCase();
  if (confirm !== "y" && confirm !== "yes") {
    term.note("cancelled — nothing was deleted.");
    await ask(`  ${chalk.gray("Press Enter to continue…")} `);
    return;
  }

  for (const target of targets) {
    try {
      fs.rmSync(target.abs, { recursive: true, force: true });
      term.ok(`removed ${target.label}`);
    } catch (error) {
      term.fail(`could not remove ${target.label}: ${error?.message || error}`);
    }
  }
  await ask(`  ${chalk.gray("Press Enter to continue…")} `);
}

/* ─────────────────────────────── entry point ─────────────────────────────── */

/**
 * Run the interactive boot console.
 *
 * @param {object} [options]
 * @param {NodeJS.ReadStream} [options.input]   stdin override (tests).
 * @param {NodeJS.WriteStream} [options.output] stdout override (tests).
 * @returns {Promise<"start"|"exit">} the action the caller should take.
 */
export async function runBootInterface(options = {}) {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  const interactive = Boolean(input.isTTY && output.isTTY);
  const forced = process.argv.includes("--no-menu");
  const disabled = ["1", "true", "yes"].includes(String(process.env.NO_MENU || "").toLowerCase());
  // An automatic restart (hot reload / `.restart`) relaunches the process with
  // this flag so it boots straight into the bot instead of reopening the menu
  // and waiting for input.
  const relaunched = process.env.GX_RELAUNCHED === "1";

  if (!interactive || forced || disabled || relaunched) return "start";

  term.use(output);
  const rl = readline.createInterface({ input, output });
  let closed = false;
  rl.on("close", () => {
    closed = true;
  });
  rl.on("SIGINT", () => {
    rl.close();
    term.write("");
    process.exit(0);
  });

  /* ── inactivity countdown ──
   * A single long-lived timer counts down; any keypress cancels it. When it
   * reaches zero the bot starts on its own. `MENU_TIMEOUT=0` disables it.
   * The live value is written onto the Timeout row (below Session/Mode), so the
   * countdown is part of the header rather than a floating line. */
  let countdownTimer = null;
  let timedOut = false;
  let timeoutOffset = 0;

  const stopCountdown = () => {
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  };

  /** Overwrite the Timeout row in place (it sits `timeoutOffset` rows above the
   *  prompt). The prompt row is repainted with readline afterwards so the cursor
   *  stays aligned with whatever the operator has typed. */
  const updateCountdown = (seconds) => {
    if (!output.isTTY || timeoutOffset <= 0) return;
    try {
      output.write(`\x1b[${timeoutOffset}A\x1b[2K`);
      output.write(`  ${chalk.gray("Timeout")} : ${timeoutInfo(seconds)}`);
      output.write(`\x1b[${timeoutOffset}B\r`);
      rl.prompt(true);
    } catch {
      /* ignore */
    }
  };

  /**
   * Prompt the operator, auto-resolving to `"__timeout__"` when they stay idle
   * past `MENU_TIMEOUT` seconds. With the timeout disabled this is a plain
   * `rl.question`.
   */
  const askWithTimeout = (question) =>
    new Promise((resolve) => {
      if (closed) return resolve("");
      const total = getMenuTimeout();
      stopCountdown();
      timedOut = false;

      if (total <= 0) {
        rl.question(question, (answer) => resolve(answer));
        return;
      }

      rl.question(question, (answer) => {
        stopCountdown();
        if (timedOut) return;
        resolve(answer);
      });

      let remaining = total;
      countdownTimer = setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) {
          stopCountdown();
          timedOut = true;
          resolve("__timeout__");
          return;
        }
        updateCountdown(remaining);
      }, 1000);
    });

  const ask = (question) =>
    new Promise((resolve) => {
      if (closed) return resolve("");
      rl.question(question, resolve);
    });

  try {
    for (;;) {
      timeoutOffset = renderMain();
      const answer = (await askWithTimeout(`  ${chalk.cyanBright("›")} `)).trim().toLowerCase();
      stopCountdown();

      if (closed) return "exit";
      if (answer === "__timeout__") {
        term.write("");
        term.note("no input — starting the bot automatically");
        rl.close();
        term.clearScreen();
        return "start";
      }

      switch (answer) {
        case "1":
          rl.close();
          term.clearScreen();
          return "start";
        case "2":
          await clearSession(ask);
          break;
        case "3":
          await settingsMenu(ask);
          break;
        case "4":
        case "q":
        case "exit":
          rl.close();
          return "exit";
        default:
          term.fail("invalid choice — enter 1, 2, 3 or 4.");
          await new Promise((resolve) => setTimeout(resolve, 600));
      }
    }
  } finally {
    stopCountdown();
    if (!closed) rl.close();
  }
}

export { parseEnvFile, setEnvValue };
