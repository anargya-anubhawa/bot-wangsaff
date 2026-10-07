/**
 * GX-ID — message pipeline
 *
 * Turns a raw Baileys message into a serialized `m`, runs the mode / ban /
 * anti-spam / cooldown gates, handles the `#note` lookup, then dispatches to
 * the case system or a plugin. Errors are logged to the console with a stack
 * trace but never shown to the user.
 */
import { serialize } from "../lib/serialize.js";
import { checkMode, checkPermission, checkCommandEnabled, levenshtein } from "../lib/middleware.js";
import { getPlugin, getPluginCount, getAllCommandNames, getAnswerHandlers, getLegacyHooks } from "../lib/plugins.js";
import { getDatabase } from "../lib/database.js";
import { handleCommand as handleCaseCommand } from "../case/index.js";
import { logCommand, logger } from "../lib/logger.js";
import { getUptime } from "./connection.js";
import { makeGlobals, runLegacyHook } from "../src/lib/GX-legacy.js";
import { handleFlowAction } from "../lib/flow-router.js";
import { runModeration, runDirectVirtexCheck } from "../lib/moderation.js";
import { runFilters } from "../lib/filters.js";
import { checkGroupCooldown, applyGroupCooldown, getGroupCooldown } from "../lib/cooldown.js";
import { isOwnerOrWhitelistedIn } from "../lib/access.js";
import { cacheViewOnce } from "../lib/view-once.js";
import { rememberMessage, recallMessage } from "../lib/recent-messages.js";
import { logModerationEvent, getExternalLogPanel } from "../lib/moderation-log.js";
import { detectMediaType, getMimetype } from "../lib/media.js";
import { getEffectiveNote } from "../lib/group-scope.js";
import { shouldShowUsage, renderCommandUsage } from "../lib/command-usage.js";
import { publishIncoming } from "../lib/console-bus.js";
import { relayWhatsAppToMinecraft } from "../lib/xmpp/manager.js";
import { sendFeedback } from "../lib/messages.js";
import config from "../config.js";
import te from "../lib/error.js";

/* ─────────────────────────── anti-spam ─────────────────────────── */

const spamTracker = new Map();
const SPAM_WINDOW = 5000;
const SPAM_LIMIT = 8;

function isSpamming(m) {
  if (!config.features?.antiSpam) return false;
  if (m.isOwner || m.fromMe) return false;
  const key = m.sender;
  const now = Date.now();
  const entry = spamTracker.get(key) || { count: 0, start: now };
  if (now - entry.start > SPAM_WINDOW) {
    entry.count = 0;
    entry.start = now;
  }
  entry.count++;
  spamTracker.set(key, entry);
  return entry.count > SPAM_LIMIT;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of spamTracker) {
    if (now - entry.start > SPAM_WINDOW * 2) spamTracker.delete(key);
  }
}, 60000).unref?.();

/* ─────────────────────────── note lookup ─────────────────────────── */

const NOTE_PATTERN = /^#([a-zA-Z0-9_\-.]+)$/;

function isNoteLookup(body) {
  if (!body) return false;
  const trimmed = body.trim();
  if (!NOTE_PATTERN.test(trimmed)) return false;
  return true;
}

async function handleNoteLookup(m, sock) {
  const name = m.body.trim().slice(1);
  const db = getDatabase();
  // Notes may be shared between linked groups — resolve the shared scope id.
  // A group's own note wins, but a `global` note is visible everywhere.
  const note = m.isGroup
    ? getEffectiveNote(db, m.chat, name)
    : db.getNote(m.sender, name);
  if (!note) {
    await m.reply(`❓ *Note not found.* No note named \`${name}\` here.`);
    return;
  }
  if (note.mediaBase64 && note.mediaType) {
    const buffer = Buffer.from(note.mediaBase64, "base64");
    const caption = note.content || undefined;
    let content;
    switch (note.mediaType) {
      case "image":
        content = { image: buffer, caption };
        break;
      case "video":
        content = { video: buffer, caption };
        break;
      case "audio":
        content = { audio: buffer, mimetype: note.mediaMimetype || "audio/mp4" };
        break;
      case "sticker":
        content = { sticker: buffer };
        break;
      default:
        content = {
          document: buffer,
          mimetype: note.mediaMimetype || "application/octet-stream",
          fileName: name,
          caption,
        };
    }
    await sock.sendMessage(m.chat, content, { quoted: m.raw });
    return;
  }
  await m.reply(note.content);
}

/* ─────────────────────────── suggestions ─────────────────────────── */

function findSuggestion(command) {
  const names = getAllCommandNames();
  let best = null;
  let bestDist = 3;
  for (const name of names) {
    const dist = levenshtein(command, name);
    if (dist < bestDist) {
      bestDist = dist;
      best = name;
    }
  }
  return best;
}

/* ─────────────────────────── game answer loop ─────────────────────────── */

/**
 * Dispatch free-text replies to active GX game sessions. Two families exist:
 *   1. GX-ID answer handlers (`answerHandler`, `dungeonAnswerHandler`, …) that
 *      take `(m, sock)` or `(m, { sock, db })` — we pass a socket augmented with
 *      `.sock`/`.db` so both destructuring styles work.
 *   2. Legacy Megami `handler.before` / `handler.all` loops (bom, kuis, maths,
 *      tebakbola, …) that rely on the legacy `conn`/`global.db` shims and are
 *      therefore routed through `runLegacyHook()`.
 * Returns `true` when a handler consumed the message.
 */
async function dispatchGameAnswers(m, sock, db) {
  const hadText = m.text;
  if (!m.text && !m.isCommand) m.text = m.body || "";
  try {
    // Some handlers take `(m, sock)` and others `(m, { sock, db })`. Expose a
    // socket view that satisfies both: methods are bound to the real socket and
    // `.sock` / `.db` are provided without mutating the socket itself.
    const hybrid = new Proxy(sock, {
      get(target, prop) {
        if (prop === "sock") return target;
        if (prop === "db") return db;
        const value = target[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    for (const { fn } of getAnswerHandlers()) {
      try {
        const result = await fn(m, hybrid);
        if (result === true) return true;
      } catch (error) {
        logger.error(`answer handler failed: ${error.message}`);
      }
    }

    for (const { fn } of getLegacyHooks()) {
      try {
        const result = await runLegacyHook(fn, m, { sock, db, config });
        if (result === true) return true;
      } catch (error) {
        logger.error(`legacy hook failed: ${error.message}`);
      }
    }
  } finally {
    m.text = hadText;
  }
  return false;
}

/* ─────────────────────────── main pipeline ─────────────────────────── */

function buildContext(m, sock, db, legacyConn, prefix) {
  return {
    sock,
    conn: legacyConn || sock,
    m,
    args: m.args,
    text: m.text,
    command: m.command,
    prefix: m.prefix || prefix,
    usedPrefix: m.prefix || prefix,
    config,
    db,
    uptime: getUptime(),
    plugins: { count: getPluginCount() },
  };
}

/**
 * Run the mode / ban / spam gates, the case system and plugin dispatch for a
 * command-shaped `m`. Shared by the ordinary pipeline and by the native-flow
 * router (so a flow tap obeys exactly the same permissions and cooldowns).
 *
 * @returns {Promise<boolean>} `true` when the command was handled.
 */
export async function runCommand(m, sock, db, legacyConn, prefix) {
  /* mode gate */
  const modeCheck = checkMode(m);
  if (!modeCheck.allowed) return true;

  /* ban gate */
  if (m.isBanned) {
    await sendFeedback(m, config.messages?.banned || "🚫 You are banned.");
    return true;
  }

  /* spam gate */
  if (isSpamming(m)) return true;

  /* command log */
  if (config.features?.logMessage) {
    logCommand({ chat: m.chat, sender: m.sender, pushName: m.pushName, body: m.body, type: m.type });
  }

  db.incrementStat("commandsUsed");

  /* presence */
  if (config.features?.autoTyping && m.isGroup) {
    sock.sendPresenceUpdate("composing", m.chat).catch(() => {});
  }

  /* case system first */
  try {
    const caseResult = await handleCaseCommand(m, sock);
    if (caseResult?.handled) {
      if (config.features?.autoTyping && m.isGroup) {
        sock.sendPresenceUpdate("paused", m.chat).catch(() => {});
      }
      return true;
    }
  } catch (error) {
    logger.error(`case handler: ${error.message}`);
  }

  /* plugin dispatch */
  const plugin = getPlugin(m.command);
  if (!plugin) {
    const suggestion = findSuggestion(m.command);
    const hint = suggestion ? `\n\n💡 Did you mean \`${prefix}${suggestion}\`?` : "";
    await sendFeedback(m, `❓ *Unknown command:* \`${prefix}${m.command}\`${hint}`);
    return true;
  }

  if (!plugin.config.isEnabled) {
    await sendFeedback(m, `⚠️ Command \`${prefix}${m.command}\` is currently disabled.`);
    return true;
  }

  /* per-command enable/disable gate (.enablecmd / .disablecmd) */
  const enabled = checkCommandEnabled(m, plugin.config);
  if (!enabled.allowed) {
    await sendFeedback(m, enabled.reason);
    return true;
  }

  /* permission gate */
  const perm = checkPermission(m, plugin.config);
  if (!perm.allowed) {
    await sendFeedback(m, perm.reason);
    return true;
  }

  /* auto usage card — a bare parent command (no args/quote/mentions) replies
     with its usage + available parameters instead of running. Opt-out commands
     declare `helpOnEmpty: false` / `runsBare: true`; aliases never trigger it. */
  if (shouldShowUsage(m, plugin.config)) {
    await m.reply(renderCommandUsage(plugin.config, prefix)).catch(() => {});
    return true;
  }

  /* cooldown gate — per-command (invoked alias), then per-group (.commandcd).
     Using the invoked alias keeps merged commands (e.g. `.addfilter` vs
     `.delfilter`) on independent cooldown buckets. */
  const cooldownKey = String(m.command || plugin.config.name).toLowerCase();
  const cooldown = plugin.config.cooldown ?? 3;
  if (cooldown > 0 && !m.isOwner) {
    const remaining = db.checkCooldown(m.sender, cooldownKey, cooldown);
    if (remaining) {
      const tpl = config.messages?.cooldown || "🕕 Cooldown: wait %time% more second(s).";
      await sendFeedback(m, tpl.replace("%time%", remaining));
      return true;
    }
  }
  if (m.isGroup && !m.isOwner && !isOwnerOrWhitelistedIn(m) && !m.isAdmin) {
    const groupCooldown = getGroupCooldown(m.chat);
    if (groupCooldown > 0) {
      const check = checkGroupCooldown(m.chat, m.sender, cooldownKey, groupCooldown);
      if (!check.allowed) {
        const tpl = config.messages?.cooldown || "🕕 Cooldown: wait %time% more second(s).";
        await sendFeedback(m, tpl.replace("%time%", check.remainingSeconds));
        return true;
      }
    }
  }

  /* execute */
  try {
    const context = buildContext(m, sock, db, legacyConn, prefix);
    await plugin.handler(m, context);
    if (cooldown > 0 && !m.isOwner) db.setCooldown(m.sender, cooldownKey, cooldown);
    if (m.isGroup && !m.isOwner && !isOwnerOrWhitelistedIn(m) && !m.isAdmin) {
      const groupCooldown = getGroupCooldown(m.chat);
      if (groupCooldown > 0) applyGroupCooldown(m.chat, m.sender, cooldownKey);
    }
    db.incrementStat("commandsSuccess");
  } catch (error) {
    logger.error(`plugin "${plugin.config.name}" failed: ${error.message}`);
    if (process.env.NODE_ENV === "development") console.error(error.stack);
    await m.reply(te(m.prefix || prefix, plugin.config.name, m.pushName)).catch(() => {});
  } finally {
    if (config.features?.autoTyping && m.isGroup) {
      sock.sendPresenceUpdate("paused", m.chat).catch(() => {});
    }
  }
  return true;
}

/* ─────────────────────────── revoke handling ─────────────────────────── */

/**
 * A user revoking (deleting) their own message arrives as a `protocolMessage`
 * with `type: 0`. We look the original message up in the short-lived recent
 * cache so the event log can show what was deleted — if it has already expired
 * only the metadata (who/when) is recorded, never a stale copy.
 */
async function handleRevoke(rawMsg, sock) {
  try {
    const proto = rawMsg.message.protocolMessage;
    const originalKey = proto.key || {};
    const chat = rawMsg.key?.remoteJid || originalKey.remoteJid || "";
    if (!String(chat).endsWith("@g.us")) return;

    const messageId = originalKey.id || null;
    const actor = rawMsg.key?.participant || originalKey.participant || null;
    const remembered = messageId ? recallMessage(chat, messageId) : null;

    await logModerationEvent(
      {
        type: "moderation",
        action: "revoked",
        reason: "manual",
        groupId: chat,
        actorId: actor,
        messageId,
        contentPreview: remembered?.body || null,
        media: remembered?.media || null,
        metadata: remembered
          ? { cached: true, mediaType: remembered.media?.mediaType || null }
          : { cached: false, detail: "konten sudah kedaluwarsa" },
      },
      sock,
    );
  } catch (error) {
    logger.error(`revoke: ${error.message}`);
  }
}

export async function messageHandler(rawMsg, sock) {
  // A revoke arrives as a `protocolMessage` (type 0 = REVOKE). Handle it before
  // normal serialization so the event log can record the deletion.
  if (rawMsg?.message?.protocolMessage?.type === 0) {
    await handleRevoke(rawMsg, sock);
    return;
  }

  let m;
  try {
    m = await serialize(sock, rawMsg);
  } catch (error) {
    logger.error(`serialize failed: ${error.message}`);
    return;
  }
  if (!m) return;

  /* Mirror the message onto the console bus so an interactive session that has
     selected this chat can display the conversation. No subscribers → no-op. */
  publishIncoming({
    chat: m.chat,
    sender: m.sender,
    pushName: m.pushName,
    body: m.body,
    type: m.type,
    isGroup: m.isGroup,
    fromMe: m.fromMe,
    id: m.id,
  });

  const db = getDatabase();

  /* legacy globals (global.conn / global.db) used by Megami-style plugins */
  let legacyConn = null;
  try {
    legacyConn = makeGlobals(sock, db, config)?.lc || null;
  } catch {
    /* ignore */
  }

  /* track user — only write when the record is new or the display name changed,
     to avoid marking users.json dirty on every single message */
  try {
    const existingUser = db.getUser(m.sender);
    if (!existingUser || (m.pushName && existingUser.name !== m.pushName)) {
      db.setUser(m.sender, { name: m.pushName });
    }
  } catch {
    /* ignore */
  }

  const prefix = m.prefix || config.command?.prefix || ".";

  /* keep the last messages in a short-lived TTL cache so a revoke can be
     reported with its original content (in-memory only, never persisted).
     Media is cached too, but only when an EXTERNAL log panel exists — that is
     the only case where the media is forwarded somewhere the group can't see. */
  if (m.isGroup && !m.fromMe && m.id) {
    try {
      const externalPanel = getExternalLogPanel(m.chat);
      const mediaType = externalPanel ? detectMediaType(m) : null;
      // Fire-and-forget: caching media must never block message processing.
      Promise.resolve(
        rememberMessage(m, {
          cacheMedia: !!mediaType,
          mediaType,
          mimetype: mediaType ? getMimetype(m) : "",
          fileName: m.fileName || "",
        }),
      ).catch(() => {});
    } catch {
      /* ignore */
    }
  }

  /* cache view-once media so `.getvo` can re-send it later */
  if (m.isViewOnce || m.quoted?.isViewOnce) {
    try {
      const source = m.isViewOnce ? m : m.quoted;
      cacheViewOnce(m.chat, source.sender || m.sender, source.type, source.download);
    } catch {
      /* ignore */
    }
  }

  /* moderation (antilink / antivirtex / antinsfw / blacklist) — group only,
     before anything else so a flagged message is deleted and not processed */
  if (m.isGroup) {
    try {
      if (await runModeration(m, sock)) return;
    } catch (error) {
      logger.error(`moderation: ${error.message}`);
    }
  } else {
    try {
      if (await runDirectVirtexCheck(m, sock, config.owner?.number)) return;
    } catch (error) {
      logger.error(`dm antivirtex: ${error.message}`);
    }
  }

  /* level XP — every group message grants XP when the group enabled levels */
  if (m.isGroup && !m.fromMe) {
    try {
      const group = db.getGroup(m.chat);
      if (group?.levelEnabled) db.addLevelXp(m.sender, m.chat, 5);
    } catch {
      /* ignore */
    }
  }

  /* native-flow response — dispatched before anything else so flow ids are
     never mistaken for game answers or commands */
  if (!m.isCommand && m.body) {
    const ctx = buildContext(m, sock, db, legacyConn, prefix);
    try {
      if (await handleFlowAction(m, ctx)) return;
    } catch (error) {
      logger.error(`flow dispatch: ${error.message}`);
    }
  }

  /* #note lookup (before command parsing) */
  if (!m.isCommand && isNoteLookup(m.body)) {
    try {
      await handleNoteLookup(m, sock);
    } catch (error) {
      logger.error(`note lookup: ${error.message}`);
      await m.reply(te(m.prefix, "note", m.pushName));
    }
    return;
  }

  /* game answer loop — free-text replies only, before command dispatch */
  if (!m.isCommand && m.body && !isNoteLookup(m.body)) {
    try {
      if (await dispatchGameAnswers(m, sock, db)) return;
    } catch (error) {
      logger.error(`game answer dispatch: ${error.message}`);
    }
  }

  /* filters — group auto-replies for ordinary (non-command) messages */
  if (!m.isCommand && m.isGroup && m.body) {
    try {
      if (await runFilters(m, sock)) return;
    } catch (error) {
      logger.error(`filter dispatch: ${error.message}`);
    }
  }

  /* XMPP bridge — relay plain-text bridge-group messages to Minecraft. Placed
     after the game/filter handlers so a message they consume is never relayed,
     and before the non-command early return so ordinary chat still reaches MC. */
  if (!m.isCommand) {
    try {
      await relayWhatsAppToMinecraft(m);
    } catch (error) {
      logger.error(`xmpp bridge: ${error.message}`);
    }
    return;
  }

  await runCommand(m, sock, db, legacyConn, prefix);
}

export { isSpamming };
