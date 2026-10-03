/**
 * GX-ID compatibility shim.
 *
 * The game subsystem copied from GX-ID expects its own database module
 * (`src/lib/GX-database.js`). Instead of running a second lowdb instance that
 * would clobber the shared `users.json` / `groups.json` / `settings.json` /
 * `stats.json` files, every GX consumer is redirected to GX-ID's single
 * database (`lib/database.js`).
 *
 * GX-ID's `Database` class already implements the GX surface used by the game
 * closure — `getUser` / `setUser` / `getGroup` / `setGroup` / `save` /
 * `setting` / `incrementStat` / `updateExp` / `markDirty` / `data` — plus the
 * added `updateEnergi` / `updateKoin` / `updateSaldo` / `getTopUsers` /
 * `resetAllEnergi` / `prepareLegacyUser` helpers.
 */
import { getDatabase as getCoreDatabase, Database } from "../../lib/database.js";

/**
 * Return the shared GX-ID database instance. GX-ID's module exposed an
 * `initDatabase(path)` bootstrap; GX-ID initializes its database in `index.js`
 * before plugins load, so this is a no-op kept only for API compatibility.
 */
async function initDatabase() {
  return getCoreDatabase();
}

/**
 * Return the shared GX-ID database. Mirrors GX-ID's throw-on-missing behaviour
 * so callers still fail loudly if they run before boot.
 */
function getDatabase() {
  const db = getCoreDatabase();
  if (!db) {
    throw new Error(
      "Database belum diinisialisasi. Panggil initDatabase terlebih dahulu.",
    );
  }
  return db;
}

export { Database, initDatabase, getDatabase };
