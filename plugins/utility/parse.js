const pluginConfig = {
  name: "parse",
  alias: [],
  category: "utility",
  description: "Ekspor info pesan dan metadata stiker sebagai JSON",
  usage: ".parse (balas pesan atau stiker)",
  examples: [".parse"],
  permission: "all",
  cooldown: 3,
  isEnabled: true,
};

export function parseWebpExif(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP") return null;

  for (let offset = 12; offset + 8 <= buffer.length;) {
    const type = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const end = offset + 8 + size;
    if (end > buffer.length) return null;
    if (type === "EXIF") {
      const data = buffer.subarray(offset + 8, end).toString("utf8").replace(/\0+$/g, "");
      const jsonStart = data.indexOf("{");
      if (jsonStart < 0) return null;
      try {
        return JSON.parse(data.slice(jsonStart));
      } catch {
        return null;
      }
    }
    offset = end + (size & 1);
  }
  return null;
}

export function toJsonSafe(value, seen = new WeakSet()) {
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return value;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  if (value instanceof Date) return value.toISOString();
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => toJsonSafe(item, seen));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toJsonSafe(item, seen)]));
}

export function findContextInfo(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || Buffer.isBuffer(value) || seen.has(value)) return null;
  seen.add(value);
  if (value.contextInfo && typeof value.contextInfo === "object") return value.contextInfo;
  for (const child of Object.values(value)) {
    const found = findContextInfo(child, seen);
    if (found) return found;
  }
  return null;
}

async function handler(m, { config }) {
  const quoted = Boolean(m.isQuoted && m.quoted);
  const target = quoted ? m.quoted : m.isMedia ? m : null;
  if (!target) {
    const prefix = m.prefix || config.command?.prefix || ".";
    return m.reply(`Balas pesan atau stiker dengan \`${prefix}parse\`.`);
  }

  const contextInfo = quoted ? findContextInfo(m.raw?.message) : null;
  const rawTarget = quoted
    ? {
        stanzaId: contextInfo?.stanzaId || target.id || "",
        participant: contextInfo?.participant || target.sender || "",
        quotedMessage: contextInfo?.quotedMessage || target.message || {},
        quotedType: contextInfo?.quotedType || target.type || "",
        contextInfo: contextInfo || {},
      }
    : m.raw;
  const result = toJsonSafe(rawTarget);
  result.parsedMessage = {
    id: target.id || target.key?.id || "",
    type: target.type || "unknown",
    sender: target.sender || m.sender || "",
    body: target.body || "",
    timestamp: target.timestamp || m.timestamp || null,
  };

  if (target.isSticker) {
    const buffer = await target.download();
    result.stickerMetadata = parseWebpExif(buffer);
  }

  const json = Buffer.from(JSON.stringify(result, null, 2));
  const id = target.id || target.key?.id || "message";
  const filename = `parse-${String(id).replace(/[^a-zA-Z0-9_-]/g, "_")}.json`;
  return m.replyDocument(json, filename, "application/json");
}

export { pluginConfig as config, handler };
