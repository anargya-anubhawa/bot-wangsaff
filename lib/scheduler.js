/**
 * GX-ID — persistent scheduler service
 *
 * Fires `schedule`d messages. Unlike a plain `setTimeout`, every schedule lives
 * in the database, so it survives a restart. The loop ticks every 30s, asks the
 * store for anything whose HH:MM matches the configured timezone, filters by
 * recurrence (daily / weekly / once), and sends anything that has not already
 * fired today.
 *
 * The socket is always resolved via `getSocket()` at send time — never a
 * captured reference — so a reconnect cannot leave the loop with a dead socket.
 */
import { getDatabase } from "./database.js";
import { getConfiguredTimezone, getCurrentTimeParts } from "./settings.js";
import { logger } from "./logger.js";
import { getSocket } from "../core/connection.js";
import { pruneEventLogs } from "./moderation-log.js";
import { GLOBAL_SCOPE, getScopeMembers } from "./group-scope.js";

const TICK_INTERVAL_MS = 30_000;
/** Event-log retention is swept at most once an hour. */
const LOG_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
let lastLogPrune = 0;
let timer = null;

function recurrenceMatchesToday(schedule, weekdayName, ddmmyyyy) {
  switch (schedule.recurrence) {
    case "daily":
      return true;
    case "weekly":
      return String(schedule.recurrenceValue || "").toLowerCase() === weekdayName;
    case "once":
      return schedule.recurrenceValue === ddmmyyyy;
    default:
      return false;
  }
}

function alreadyFiredToday(schedule, ddmmyyyy) {
  if (!schedule.lastSentAt) return false;
  const timezone = getConfiguredTimezone();
  return getCurrentTimeParts(timezone, new Date(schedule.lastSentAt)).ddmmyyyy === ddmmyyyy;
}

function buildContent(schedule) {
  if (schedule.mediaBase64 && schedule.mediaType) {
    const buffer = Buffer.from(schedule.mediaBase64, "base64");
    const caption = schedule.content || undefined;
    switch (schedule.mediaType) {
      case "image":
        return { image: buffer, caption };
      case "video":
        return { video: buffer, caption };
      case "audio":
        return { audio: buffer, mimetype: schedule.mediaMimetype || "audio/mp4" };
      case "sticker":
        return { sticker: buffer };
      case "document":
        return {
          document: buffer,
          mimetype: schedule.mediaMimetype || "application/octet-stream",
          caption,
        };
      default:
        return { text: schedule.content || "" };
    }
  }
  return { text: schedule.content || "" };
}

async function tick(sockOverride = null) {
  let db;
  try {
    db = getDatabase();
  } catch {
    return;
  }

  /* periodic retention sweep for the moderation event log (cheap, hourly) */
  if (Date.now() - lastLogPrune > LOG_PRUNE_INTERVAL_MS) {
    lastLogPrune = Date.now();
    try {
      const removed = pruneEventLogs();
      if (removed) logger.info(`[scheduler] pruned ${removed} expired event log(s)`);
    } catch (error) {
      logger.warn(`[scheduler] log prune failed: ${error.message}`);
    }
  }

  const timezone = getConfiguredTimezone();
  const { hhmm, weekdayName, ddmmyyyy } = getCurrentTimeParts(timezone);
  const sock = sockOverride || getSocket();
  if (!sock) return;

  for (const schedule of db.listSchedules()) {
    if (!schedule.active) continue;
    if (schedule.sendTime !== hhmm) continue;
    if (!recurrenceMatchesToday(schedule, weekdayName, ddmmyyyy)) continue;
    if (alreadyFiredToday(schedule, ddmmyyyy)) continue;

    /* a `global` schedule fans out to every registered group; otherwise the
       schedule fires in its own group plus every group that shares the
       `schedule` scope with it (`.link schedule <a> <b>`) */
    const targets =
      schedule.jid === GLOBAL_SCOPE
        ? db.listRegistrations().filter((r) => r.status === "active").map((r) => r.jid)
        : getScopeMembers("schedule", schedule.jid);

    let anySent = false;
    for (const jid of targets) {
      try {
        await sock.sendMessage(jid, buildContent(schedule));
        anySent = true;
        logger.info(`[scheduler] sent schedule ${schedule.id} to ${jid}`);
      } catch (error) {
        logger.error(`[scheduler] failed to send ${schedule.id} to ${jid}: ${error.message}`);
      }
    }
    if (anySent) {
      db.updateSchedule(schedule.id, { lastSentAt: new Date().toISOString() });
      if (schedule.recurrence === "once") db.updateSchedule(schedule.id, { active: false });
    }
  }
}

/** Start the background loop (idempotent). */
export function startScheduler() {
  if (timer) return;
  timer = setInterval(() => {
    tick().catch((error) => logger.error(`[scheduler] tick failed: ${error.message}`));
  }, TICK_INTERVAL_MS);
  timer.unref?.();
  logger.info(`[scheduler] started (tick ${TICK_INTERVAL_MS / 1000}s, tz ${getConfiguredTimezone()})`);
}

/**
 * Run a single scheduler tick immediately. Exported so tests can exercise the
 * due-schedule path without waiting for the 30s interval. Pass `sock` to inject
 * a socket (otherwise the live connection is used).
 */
export function runSchedulerTick(sock = null) {
  return tick(sock);
}

export function stopScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
