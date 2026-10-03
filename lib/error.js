/**
 * GX-ID — error message helper
 *
 * Returns the SAFE user-facing message for a failed command. The command name,
 * stack trace, database path and any credentials are never included — those go
 * to the internal logger only (see `core/message.js`).
 */
import config from "../config.js";

export default function te(/* prefix, command, pushName */) {
  return (
    config.messages?.genericError ||
    "❌ Terjadi kesalahan saat menjalankan perintah.\nSilakan coba lagi."
  );
}
