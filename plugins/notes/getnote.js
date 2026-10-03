/**
 * GX-ID — /getnote
 *
 * Sends a saved note (text or media). Notes may be shared between linked groups.
 *
 *   .getnote <nama>              → current group
 *   .getnote <grup> <nama>       → remote group (alias or id)
 *
 * This is the explicit form of the `#name` shortcut handled by the pipeline.
 */
import { resolveGroup, resolveDataTarget } from "../../lib/group-registry.js";
import { resolveScopeId, getEffectiveNote } from "../../lib/group-scope.js";

const pluginConfig = {
  name: "getnote",
  alias: ["shownote", "viewnote", "lihatcatatan"],
  category: "notes",
  description: "Tampilkan sebuah catatan (teks/media)",
  usage: ".getnote [grup] <nama>",
  examples: [".getnote rules", ".getnote kelas-a materi1"],
  permission: "all",
  cooldown: 3,
  isEnabled: true,
};

async function handler(m, ctx) {
  const { db, sock, config } = ctx;
  const prefix = m.prefix || config.command?.prefix || ".";
  const args = m.args || [];

  let targetArg = null;
  let name;
  if (args.length >= 2 && resolveGroup(args[0])) {
    targetArg = args[0];
    name = (args[1] || "").toLowerCase();
  } else {
    name = (args[0] || "").toLowerCase();
  }

  if (!name) {
    return m.reply(`📝 *Lihat Catatan*\n\n> Usage: \`${prefix}getnote [grup] <nama>\``);
  }

  const target = await resolveDataTarget(m, ctx, { args: targetArg ? [targetArg] : [] });
  if (target.error) return m.reply(target.error);

  const scope = resolveScopeId("notes", target.jid);
  const note = db.getNote(scope, name) || getEffectiveNote(db, target.jid, name);
  if (!note) return m.reply(`❓ Tidak ada catatan bernama \`${name}\` di grup itu.`);

  if (note.mediaBase64 && note.mediaType) {
    const buffer = Buffer.from(note.mediaBase64, "base64");
    const caption = note.content || undefined;
    let content;
    switch (note.mediaType) {
      case "image":
        content = { image: buffer, caption };
        break;
      case "audio":
        content = { audio: buffer, mimetype: note.mediaMimetype || "audio/mp4" };
        break;
      case "sticker":
        content = { sticker: buffer };
        break;
      default:
        content = { document: buffer, mimetype: note.mediaMimetype || "application/octet-stream", fileName: name };
    }
    await sock.sendMessage(m.chat, content, { quoted: m.raw });
    return;
  }

  await m.reply(note.content || "*(kosong)*");
}

export { pluginConfig as config, handler };
