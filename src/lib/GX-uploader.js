/**
 * GX-ID — image/media uploader + asset persister.
 *
 * `uploadImage()` (aliased for the legacy helper names) POSTs a buffer to the
 * configured CDN and returns the public URL. Credentials come from `config.js`
 * (which in turn reads `GX.js` / `.env`) — never hardcoded here.
 */
import axios from "axios";
import FormData from "form-data";
import fs from "fs";
import path from "path";
import config from "../../config.js";
import { updateAssetAndSave } from "./GX-asset-manager.js";

/** Upload a buffer and return its public URL. */
async function uploadToTermai(buffer, filename = "image.jpg") {
  const domain = config.apiBase?.termaiCdn || "https://c.termai.cc";
  const key = config.APIkey?.termaiCdn || "";

  const form = new FormData();
  form.append("file", buffer, { filename });

  const url = key ? `${domain}/api/upload?key=${encodeURIComponent(key)}` : `${domain}/api/upload`;
  const response = await axios.post(url, form, {
    headers: { ...form.getHeaders(), "User-Agent": "Mozilla/5.0" },
    timeout: 60000,
  });

  if (response.data?.status && response.data?.path) {
    return response.data.path;
  }

  throw new Error("Upload gagal");
}

export const uploadImage = uploadToTermai;
export const uploadToTelegraph = uploadToTermai;
export const uploadTo0x0 = uploadToTermai;
export const uploadToCatbox = uploadToTermai;
export const uploadToTmpfiles = uploadToTermai;
export const uploadToUguu = uploadToTermai;

/**
 * Persist a freshly produced asset: choose a local path, record it in
 * `config.assets`, rewrite the `assets` block in `config.js`, then write the
 * buffer to disk.
 *
 * @param {string} assetKey
 * @param {Buffer} buffer
 * @param {string} [filename]
 * @returns {Promise<string>} the local path (relative to the project root)
 */
export async function updateAssetUrl(assetKey, buffer, filename = "image.jpg") {
  let localPath = config.assets?.[assetKey];

  if (!localPath || localPath.startsWith("http")) {
    let folder = "image";
    if (filename.endsWith(".mp4")) folder = "video";
    else if (filename.endsWith(".mp3")) folder = "audio";

    localPath = `./assets/${folder}/${filename}`;

    if (!config.assets) config.assets = {};
    config.assets[assetKey] = localPath;

    const configPath = path.join(process.cwd(), "config.js");
    let configContent = fs.readFileSync(configPath, "utf8");

    const regex = new RegExp(`("${assetKey}"\\s*:\\s*)"([^"]+)"`);
    if (regex.test(configContent)) {
      configContent = configContent.replace(regex, `$1"${localPath}"`);
    } else {
      const assetsBlockRegex = /(assets\s*:\s*\{)([^}]*)(\})/;
      if (assetsBlockRegex.test(configContent)) {
        configContent = configContent.replace(assetsBlockRegex, (match, p1, p2, p3) => {
          let inner = p2.trim();
          if (inner.endsWith(",")) inner = inner.slice(0, -1);
          if (inner.length > 0) return `${p1}\n    ${inner},\n    "${assetKey}": "${localPath}"\n  ${p3}`;
          return `${p1}\n    "${assetKey}": "${localPath}"\n  ${p3}`;
        });
      }
    }
    fs.writeFileSync(configPath, configContent, "utf8");
  }

  await updateAssetAndSave(assetKey, buffer, localPath);

  return localPath;
}
