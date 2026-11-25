const pluginConfig = {
  name: "parse",
  alias: [],
  category: "utility",
  description: "Ekspor info pesan dan metadata stiker sebagai JSON",
  usage: ".parse (balas pesan atau stiker)",
  examples: [".parse"],
  permission: "all",
  cooldown: 3,
  helpOnEmpty: false,
  isEnabled: true,
};

const safeFields = [
  "mimetype",
  "fileLength",
  "fileName",
  "width",
  "height",
  "seconds",
  "ptt",
  "isAnimated",
  "isAvatar",
  "isAiSticker",
  "stickerSentTs",
  "firstFrameLength",
  "caption",
  "text",
];

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

function getTargetInfo(target) {
  const content = target.message?.[target.type] || {};
  const info = {};
  for (const field of safeFields) {
    if (content[field] !== undefined && (typeof content[field] !== "object" || content[field] === null)) info[field] = content[field];
  }
  return {
    id: target.id || target.key?.id || "",
    type: target.type || "unknown",
    sender: target.sender || "",
    body: target.body || "",
    timestamp: target.timestamp || null,
    content: info,
  };
}

async function handler(m, { config }) {
  const target = m.isQuoted ? m.quoted : m.isMedia ? m : null;
  if (!target) {
    const prefix = m.prefix || config.command?.prefix || ".";
    return m.reply(`Balas pesan atau stiker dengan \`${prefix}parse\`.`);
  }

  const result = getTargetInfo(target);
  if (target.isSticker) {
    const buffer = await target.download();
    result.stickerMetadata = parseWebpExif(buffer);
  }

  const json = Buffer.from(JSON.stringify(result, null, 2));
  const filename = `parse-${String(result.id || "message").replace(/[^a-zA-Z0-9_-]/g, "_")}.json`;
  return m.replyDocument(json, filename, "application/json");
}

export { pluginConfig as config, handler };
