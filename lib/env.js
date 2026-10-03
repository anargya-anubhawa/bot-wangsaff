/**
 * GX-ID — environment loader
 *
 * Loads `.env` using Node's built-in loader (no external dependency). This
 * module MUST be the first import in `index.js` so that `config.js` (which
 * reads `process.env` at module evaluation time) sees the loaded values.
 */
import fs from "fs";
import path from "path";

try {
  const envPath = path.join(process.cwd(), ".env");
  if (typeof process.loadEnvFile === "function" && fs.existsSync(envPath)) {
    process.loadEnvFile(envPath);
  }
} catch {
  /* .env is optional */
}

export default true;
