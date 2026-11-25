import assert from "node:assert/strict";
import { parseWebpExif } from "../plugins/utility/parse.js";

const metadata = { "sticker-pack-name": "GX-ID", audio: "sample" };
const payload = Buffer.from(JSON.stringify(metadata));
const chunk = Buffer.alloc(8 + payload.length + (payload.length & 1));
chunk.write("EXIF", 0, "ascii");
chunk.writeUInt32LE(payload.length, 4);
payload.copy(chunk, 8);
const webp = Buffer.alloc(12 + chunk.length);
webp.write("RIFF", 0, "ascii");
webp.writeUInt32LE(webp.length - 8, 4);
webp.write("WEBP", 8, "ascii");
chunk.copy(webp, 12);

assert.deepEqual(parseWebpExif(webp), metadata);
assert.equal(parseWebpExif(Buffer.from("not-webp")), null);
