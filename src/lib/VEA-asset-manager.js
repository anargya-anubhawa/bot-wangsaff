/**
 * GX-ID compatibility shim — asset helpers.
 *
 * The canonical implementation lives in `lib/asset-manager.js`. This module
 * simply re-exports it so the GX game subsystem (`GX-games.js`, `GX-context.js`)
 * shares a single asset cache with the rest of the bot instead of preloading
 * the same files twice during boot.
 */
import fs from "fs";
import path from "path";
import {
  preloadAssets,
  getAssetBuffer,
  getRemoteAssetBuffer,
  isRemoteUrl,
} from "../../lib/asset-manager.js";

/**
 * Persist a freshly downloaded asset buffer to disk and drop it into the shared
 * cache. Used by `GX-uploader.js` after it writes an asset back into config.js.
 * The canonical cache lives in `lib/asset-manager.js`, which has no write API,
 * so the buffer is written straight to the resolved path and re-read lazily on
 * next `getAssetBuffer()`.
 *
 * @param {string} _assetKey
 * @param {Buffer} buffer
 * @param {string} localPath path relative to the project root
 */
export async function updateAssetAndSave(_assetKey, buffer, localPath) {
  const fullPath = path.resolve(process.cwd(), localPath);
  const dir = path.dirname(fullPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  await fs.promises.writeFile(fullPath, buffer);
  return fullPath;
}

export { preloadAssets, getAssetBuffer, getRemoteAssetBuffer, isRemoteUrl };
