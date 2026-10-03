/**
 * GX-ID — logger
 *
 * Console output uses the required bracket tag format:
 *   [GX-ID][INFO] message
 *   [GX-ID][ERROR] message
 *
 * Available tags: INFO, SUCCESS, WARN, ERROR, COMMAND, PLUGIN, GROUP,
 * DATABASE, API, CONNECTION, SYSTEM, DEBUG.
 */
import chalk from "chalk";
import { format } from "util";
import * as time from "./time.js";
import { publishLog } from "./log-bus.js";

const TAGS = {
  info: "INFO",
  success: "SUCCESS",
  warn: "WARN",
  error: "ERROR",
  command: "COMMAND",
  plugin: "PLUGIN",
  group: "GROUP",
  database: "DATABASE",
  api: "API",
  connection: "CONNECTION",
  system: "SYSTEM",
  debug: "DEBUG",
};

const COLORS = {
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

function stamp() {
  return chalk.gray(time.formatTime("HH:mm:ss"));
}

function write(tagKey, ...args) {
  const tag = TAGS[tagKey] || "INFO";
  const paint = COLORS[tag] || chalk.white;
  const prefix = `${chalk.bold.gray("[GX-ID]")}${paint(`[${tag}]`)}`;
  const line = `${stamp()} ${prefix}`;
  if (tagKey === "error") console.error(line, ...args);
  else console.log(line, ...args);

  /* Mirror to the control console (no-op when nobody is subscribed). */
  let message;
  try {
    message = typeof args[0] === "string" ? format(...args) : args.map(String).join(" ");
  } catch {
    message = args.map(String).join(" ");
  }
  publishLog({ tag, message, time: new Date().toISOString() });
}

export const logger = {
  info: (...a) => write("info", ...a),
  success: (...a) => write("success", ...a),
  warn: (...a) => write("warn", ...a),
  error: (...a) => write("error", ...a),
  command: (...a) => write("command", ...a),
  plugin: (...a) => write("plugin", ...a),
  group: (...a) => write("group", ...a),
  database: (...a) => write("database", ...a),
  api: (...a) => write("api", ...a),
  connection: (...a) => write("connection", ...a),
  system: (...a) => write("system", ...a),
  debug: (...a) => {
    if (process.env.NODE_ENV === "development") write("debug", ...a);
  },
};

export function banner(info = {}) {
  const { name = "GX-ID", version = "1.0.0", mode = "public", owner = "Owner" } = info;
  console.log("");
  console.log(chalk.cyanBright.bold("   ██████╗  ███████╗ ███╗   ██╗ ███████╗ ████████╗ ██╗  ██████╗  ██╗ ██████╗"));
  console.log(chalk.cyanBright.bold("  ██╔════╝  ██╔════╝ ████╗  ██║ ██╔════╝ ╚══██╔══╝ ██║ ██╔════╝  ██║ ██╔══██╗"));
  console.log(chalk.cyanBright.bold("  ██║  ███╗ █████╗   ██╔██╗ ██║ █████╗      ██║    ██║ ██║       ██║ ██║  ██║"));
  console.log(chalk.cyanBright.bold("  ██║   ██║ ██╔══╝   ██║╚██╗██║ ██╔══╝      ██║    ██║ ██║       ██║ ██║  ██║"));
  console.log(chalk.cyanBright.bold("  ╚██████╔╝ ███████╗ ██║ ╚████║ ███████╗    ██║    ██║ ╚██████╗  ██║ ██████╔╝"));
  console.log(chalk.cyanBright.bold("   ╚═════╝  ╚══════╝ ╚═╝  ╚═══╝ ╚══════╝    ╚═╝    ╚═╝  ╚═════╝  ╚═╝ ╚═════╝"));
  console.log("");
  console.log(`  ${chalk.whiteBright.bold(name)} ${chalk.gray(`v${version}`)} ${chalk.gray("•")} ${chalk.cyanBright(mode)} ${chalk.gray("•")} ${chalk.gray(owner)}`);
  console.log("");
}

export function logCommand({ chat, sender, pushName, body, type }) {
  const where = chat?.endsWith("@g.us") ? chalk.green("group") : chalk.cyan("private");
  console.log(
    `  ${chalk.gray("├─")} ${where} ${chalk.whiteBright(pushName || sender)} ${chalk.gray("›")} ${chalk.magentaBright(body || type)}`,
  );
}

export function logBox(title, lines = []) {
  console.log("");
  console.log(`  ${chalk.gray("╭─")} ${chalk.bold(title)}`);
  for (const line of lines) console.log(`  ${chalk.gray("│")}  ${line}`);
  console.log(`  ${chalk.gray("╰─")}`);
}

export { chalk };
