/**
 * GX-ID — control console launcher
 *
 * Connects to a running bot over its local control socket and opens the
 * interactive UI in this terminal. Run it with `npm run console` while the bot
 * is already running (`npm start`).
 *
 * Usage:
 *   node console.js
 *   CONSOLE_PIPE=/custom/path node console.js
 */
import "./lib/env.js";
import { startControlConsole } from "./lib/control-client.js";
import { logger } from "./lib/logger.js";

startControlConsole().catch((error) => {
  logger.error(`console failed: ${error?.message || error}`);
  process.exit(1);
});
