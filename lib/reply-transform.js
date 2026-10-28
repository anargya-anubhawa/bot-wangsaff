/**
 * GX-ID — reply transformer ("super silent" mode + automatic status reaction)
 *
 * Wraps `m.reply*()` and `m.react()` so a command's output can be minimised
 * WITHOUT touching 240+ plugin call sites:
 *
 *   super silent ON  → every reply of a finished command is dropped and
 *                      replaced by a reaction:
 *                        🟢 the command reported success
 *                        🔴 the command reported a failure
 *                        🟡 anything else (or a media-only reply)
 *                      While the command is still running its reply is held
 *                      back ("hold") and only delivered if the command never
 *                      speaks again — so "processing…" followed by a result
 *                      resolves to exactly one reaction.
 *
 *   super silent OFF → a command that sends nothing and throws nothing gets a
 *                      single ✅ reaction, and a lone "✅ Done!"-style toast
 *                      reply is collapsed into that reaction as well. Real
 *                      output (media, help cards, game questions) is untouched.
 *
 * Cancels: a plugin that asked a question may throw `cancel()` instead of
 * failing. The replies it already sent stay, its outcome is recorded, and no
 * error template is sent.
 *
 * The outcome comes from the CALL SITE first (handler returned true / false /
 * threw), so text-level emoji detection only breaks ties for the many plugins
 * that simply `return m.reply(...)`.
 *
 * Escape hatches — per reply or in the handler context:
 *   { keep: true }        always deliver the reply verbatim
 *   { silentKind: "…" }   force the classification ("ok" | "fail" | "info")
 *   ctx.output.*          explicit status API (done / fail / keep / silent)
 */
import config from "../config.js";
import { getDatabase } from "./database.js";

/* ─────────────────────────── toggles ─────────────────────────── */

/**
 * Master switch for the whole transformer. Set by test suites that assert on raw
 * reply text (they need the pre-transform behaviour); production never sets it.
 * Configurable through `config.messages.transformEnabled`.
 */
export function transformEnabled() {
  return config.messages?.transformEnabled !== false;
}

/**
 * Is super silent mode on? The persisted `silentLevel` wins; when it was never
 * set, the config default (`messages.superSilent`) applies.
 */
export function superSilent() {
  if (!transformEnabled()) return false;
  try {
    const stored = getDatabase().setting("silentLevel");
    if (stored === "super") return true;
    if (stored === "on" || stored === "off") return false;
  } catch {
    /* database not ready — fall through to the config default */
  }
  return config.messages?.superSilent === true;
}

/** Persist the master silent mode: `"off"` | `"on"` | `"super"`. Pass
 *  `undefined` to clear the override so the config default applies again. */
export function setSilentLevel(level) {
  if (level === undefined) {
    try {
      getDatabase().setting("silentLevel", null);
      return true;
    } catch {
      return false;
    }
  }
  const value = ["off", "on", "super"].includes(level) ? level : "off";
  try {
    getDatabase().setting("silentLevel", value);
    return true;
  } catch {
    return false;
  }
}

/**
 * The current master silent mode: `"off"` | `"on"` | `"super"`.
 *
 * Precedence: the persisted `silentLevel` → the legacy boolean `silentMode`
 * override → `config.messages.superSilent` → `config.messages.silent` → the
 * legacy `config.messages.enabled === false`.
 *
 * The config values are read live (not captured at import) so tests and runtime
 * config edits take effect immediately.
 */
export function silentLevel() {
  try {
    const stored = getDatabase().setting("silentLevel");
    if (stored === "super") return "super";
    if (stored === "on" || stored === "off") return stored;
    const legacy = getDatabase().setting("silentMode");
    if (typeof legacy === "boolean") return legacy ? "on" : "off";
  } catch {
    /* database not ready — fall through to the config defaults */
  }
  if (config.messages?.superSilent === true) return "super";
  return isConfigSilent() ? "on" : "off";
}

/** The config-file silent default (used before the database is ready). */
export function isConfigSilent() {
  if (typeof config.messages?.silent === "boolean") return config.messages.silent;
  return config.messages?.enabled === false;
}

/* ─────────────────────────── messages ─────────────────────────── */

const messages = () => config.messages || {};

/** Emoji used for each outcome of a minimised reply. */
export function emojiFor(kind) {
  if (kind === "ok") return messages().reactSuccess || "🟢";
  if (kind === "fail") return messages().reactFail || "🔴";
  return messages().reactInfo || "🟡";
}

/**
 * The single emoji that confirms a command in NORMAL (non-super) mode. It is
 * deliberately neutral — the green/red/amber status lights belong to super
 * silent mode only.
 */
function collapseEmoji() {
  return messages().reactCollapse || "✅";
}

/* ─────────────────────────── classification ─────────────────────────── */

/**
 * Markers live in `config.messages` so a deployment can tune them without code.
 * Each entry is a string (matched on word boundaries, so "nonaktif" does not
 * match "aktif") or a RegExp.
 */
const DEFAULT_SUCCESS_MARKERS = [
  "berhasil",
  "sukses",
  "done",
  "success",
  "successfully",
  "saved",
  "tersimpan",
  "terkirim",
  "dikirim",
  "sent",
  "enabled",
  "activated",
  "diaktifkan",
  "dinyalakan",
  "ditambahkan",
  "terdaftar",
  "didaftarkan",
  "registered",
  "dibuat",
  "dihapus",
  "dikembalikan",
  "dipromosikan",
  "diturunkan",
  "ditendang",
  "diubah",
  "updated",
  "added",
  "removed",
  "deleted",
  "kicked",
  "promoted",
  "demoted",
  "approved",
  "disetujui",
  "unbanned",
  "dibanned",
  "diblokir",
  "dimuted",
  "selesai",
  "completed",
  /✅|🟢/u,
];

const DEFAULT_FAILURE_MARKERS = [
  "gagal",
  "error",
  "failed",
  "fail",
  "kesalahan",
  "tidak bisa",
  "tidak dapat",
  "tidak ditemukan",
  "tidak ada",
  "tidak valid",
  "tidak dikenal",
  "tidak didukung",
  "not found",
  "not valid",
  "invalid",
  "unsupported",
  "unknown",
  "cannot",
  "could not",
  "unable",
  "denied",
  "ditolak",
  "rejected",
  "dibatalkan",
  "dibatal",
  "cancelled",
  "canceled",
  "expired",
  "kadaluarsa",
  "required",
  "wajib",
  "missing",
  "only",
  "hanya",
  /❌|🚫|⚠️|🛑/u,
];

/**
 * Weak markers only count when the reply does NOT look like a status/diagnostic
 * report. `.ping` legitimately prints "Server Ping: Timeout" on a host without
 * ICMP, and a command's own "Keterangan: …" row may mention an error count —
 * neither is a failure.
 */
const DEFAULT_WEAK_FAILURE_MARKERS = ["timeout", "gagal", "fail", "error"];

/** Texts with these markers are reports, not verdicts. */
const DEFAULT_REPORT_MARKERS = [/🏓|pong|latency|uptime|processing|server ping|bot processing/u];

function markerList(key, fallback) {
  const value = messages()[key];
  return Array.isArray(value) && value.length ? value : fallback;
}

function markerMatches(text, marker) {
  if (marker instanceof RegExp) return marker.test(text);
  const needle = String(marker).toLowerCase().trim();
  if (!needle) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(text);
}

/**
 * Classify reply text as "ok" / "fail" / "info".
 *
 * Success is checked first: a success headline may go on to mention an error
 * count and is still a success. A "report" (a dashboard/status dump, e.g. the
 * `.ping` latency table) is never treated as a failure verdict, so a single
 * "Timeout" field inside it cannot turn a working command red.
 */
export function classifyText(text) {
  const value = String(text || "").toLowerCase();
  if (!value.trim()) return "info";

  for (const marker of markerList("successMarkers", DEFAULT_SUCCESS_MARKERS)) {
    if (markerMatches(value, marker)) return "ok";
  }
  for (const marker of markerList("failureMarkers", DEFAULT_FAILURE_MARKERS)) {
    if (markerMatches(value, marker)) return "fail";
  }
  for (const marker of markerList("weakFailureMarkers", DEFAULT_WEAK_FAILURE_MARKERS)) {
    if (!markerMatches(value, marker)) continue;
    // a weak marker inside a status/diagnostic report is not a verdict
    const isReport = markerList("reportMarkers", DEFAULT_REPORT_MARKERS).some((m) =>
      markerMatches(value, m),
    );
    return isReport ? "info" : "fail";
  }
  return "info";
}

const KIND_RANK = { info: 0, ok: 1, fail: 2 };

/** Combine two outcomes, keeping the worse one. */
function worst(current, next) {
  if (!current) return next;
  if (!next) return current;
  return KIND_RANK[next] > KIND_RANK[current] ? next : current;
}

/* ─────────────────────────── cancel signal ─────────────────────────── */

/**
 * Thrown by a plugin to abort the running command without an error template.
 * The replies already sent stay; `outcome` decides the super-mode reaction.
 */
export class CancelSignal extends Error {
  constructor(outcome = "info") {
    super("command cancelled");
    this.name = "CancelSignal";
    this.outcome = ["ok", "fail", "info"].includes(outcome) ? outcome : "info";
    this.__gxCancel = true;
  }
}

/** Throw a CancelSignal. */
export function cancel(outcome = "info") {
  throw new CancelSignal(outcome);
}

/* ─────────────────────────── per-message state ─────────────────────────── */

const states = new WeakMap();

/** Open native-flow prompts, keyed by chat: `flowState | true`. */
const pendingPrompts = new Map();

function freshState() {
  return {
    super: false,
    /* replies held back while the command runs */
    hold: [],
    /* outcome already decided (by a delivered reply, a reaction or folding) */
    outcome: null,
    /* something reached the chat, or the outcome was decided explicitly */
    delivered: false,
    /* an error template was delivered; never stack a red reaction on top */
    errorGiven: false,
    /* every string the plugin tried to send, for text-level classification */
    text: null,
    textHeld: false,
    hadMedia: false,
    /* normal mode: a lone toast reply was collapsed into a reaction */
    collapsed: false,
    /* set while a held reply is being replayed (must not re-enter the filter) */
    replaying: false,
    /* an explicit reaction/status was already emitted for this turn */
    reacted: null,
  };
}

function stateOf(m) {
  let state = states.get(m);
  if (!state) {
    state = freshState();
    states.set(m, state);
  }
  return state;
}

function resetState(state) {
  const next = freshState();
  next.super = state.super;
  return next;
}

/* ─────────────────────────── send instrumentation ─────────────────────────── */

/** A minimal thenable that behaves like a Baileys send result for plugins. */
function replyRecord(m, kind = null, media = false) {
  const record = {
    __gxReply: true,
    outcome: kind,
    then(resolve, reject) {
      if (kind) stateOf(m).outcome = worst(stateOf(m).outcome, kind);
      return Promise.resolve(media ? null : undefined).then(resolve, reject);
    },
    catch(reject) {
      return Promise.resolve(media ? null : undefined).catch(reject);
    },
  };
  return record;
}

/**
 * Wrap the reply/react helpers of a serialized message.
 * Called once per message by `lib/serialize.js`; every toggle defaults to off,
 * so non-command flows behave exactly as before.
 *
 * @param {object} m serialized message (must already have `reply` / `react`)
 * @returns {object} the same message
 */
export function instrumentMessage(m) {
  if (typeof m?.reply !== "function") return m;
  if (!transformEnabled()) return m;
  const rawReply = m.reply.bind(m);
  const rawReact = typeof m.react === "function" ? m.react.bind(m) : null;

  /** Status reactions bypass the transformer (they ARE the output). */
  m.__reactRaw = rawReact;

  /** Real delivery, used for replays and for `keep` replies. */
  const deliver = async (text, options = {}) => {
    const result = await rawReply(text, options);
    const state = stateOf(m);
    state.delivered = true;
    return result;
  };

  const sendText = (text, options = {}) => {
    const state = stateOf(m);
    const value = text === 0 ? "0" : text;
    const isText = value !== undefined && value !== null && !options.media;

    if (state.replaying) return replyRecord(m);

    /* media replies are never collapsed — under super mode they are dropped,
       but held so they can be replayed when the outcome is inconclusive */
    if (!isText) {
      state.hadMedia = true;
      state.delivered = !state.super;
      if (state.super) {
        const record = replyRecord(m, "info", true);
        state.hold.push({ text: value, options, player: null, record });
        return record;
      }
      return deliver(value, options);
    }

    state.text = `${state.text || ""}${value}\n`;

    if (options.keep) {
      state.delivered = true;
      return deliver(value, options);
    }

    if (state.super) {
      state.textHeld = true;
      const record = replyRecord(m, options.silentKind || null);
      state.hold.push({ text: value, options, player: (t, o) => deliver(t, o), record });
      return record;
    }

    /* normal mode — collapse a lone toast reply ("✅ Done!") into a reaction */
    const kind = options.silentKind || classifyText(value);
    const isToast =
      !state.delivered && (options.minimal === true || (kind === "ok" && isOneLiner(value)));
    if (isToast) {
      state.collapsed = true;
      return replyRecord(m, "ok");
    }

    return deliver(value, options);
  };

  m.reply = (text, options = {}) => sendText(text, options);

  /* media helpers: `replyImage(buf, caption)`, `replyDocument(doc, name, type)`… */
  for (const name of ["replyImage", "replyVideo", "replyAudio", "replySticker", "replyDocument"]) {
    const original = m[name];
    if (typeof original !== "function") continue;
    m[name] = (payload, ...rest) => {
      const state = stateOf(m);
      if (state.replaying) return Promise.resolve(null);

      const caption = typeof rest[0] === "string" ? rest[0] : "";
      /* super mode holds the media: a verdict collapses the whole turn into one
         reaction, an inconclusive turn replays the media untouched. */
      if (state.super) {
        state.hadMedia = true;
        if (caption) state.text = `${state.text || ""}${caption}\n`;
        const record = replyRecord(m, "info", true);
        state.hold.push({
          text: caption,
          options: {},
          record,
          player: () => original.call(m, payload, ...rest),
        });
        return record;
      }

      state.delivered = true;
      state.hadMedia = true;
      return original.call(m, payload, ...rest);
    };
  }

  m.react = async (emoji) => {
    const state = stateOf(m);
    state.delivered = true;
    const status = String(emoji || "").trim();
    if (status === emojiFor("ok")) state.outcome = worst(state.outcome, "ok");
    else if (status === emojiFor("fail")) state.outcome = worst(state.outcome, "fail");
    return rawReact?.(emoji);
  };

  return m;
}

function isOneLiner(text) {
  return String(text).trim().split("\n").filter(Boolean).length === 1;
}

/* ─────────────────────────── turn lifecycle ─────────────────────────── */

/**
 * Start a command turn (called by the pipeline right before a plugin handler).
 * @param {object} m
 * @param {object} [options]
 * @param {object} [options.flowState] state inherited from a tapped prompt
 */
export function beginTurn(m, options = {}) {
  const inherited = options.flowState;
  if (inherited && typeof inherited === "object") {
    states.set(m, resetState(inherited));
  } else {
    stateOf(m);
  }
  const state = states.get(m);
  state.active = true;
  state.super = superSilent();
  return state;
}
/** The state object to hand to a flow handler so a tap continues this turn. */
export function stateForPrompt(m) {
  const state = stateOf(m);
  return { super: state.super };
}

/**
 * Record that a native-flow prompt (a menu waiting for a tap) was delivered.
 * The prompt IS the command's output, so no automatic reaction is stacked on it.
 */
export function markPromptDelivered(m, chat, flowState = null) {
  markDelivered(m);
  if (chat) pendingPrompts.set(chat, flowState || true);
}

/** Take (and clear) the open prompt for a chat, if any. */
export function takePendingPrompt(chat) {
  if (!chat || !pendingPrompts.has(chat)) return null;
  const pending = pendingPrompts.get(chat);
  pendingPrompts.delete(chat);
  return pending;
}

/** Note a reply was delivered outside the wrapper (e.g. a case command). */
export function markDelivered(m, kind = null) {
  if (!m) return;
  const state = stateOf(m);
  state.delivered = true;
  if (kind) state.outcome = worst(state.outcome, kind);
}

/**
 * Fold a handler's return value into the turn, then emit the summary.
 * @returns {Promise<void>}
 */
export async function finishTurn(m, value) {
  const state = stateOf(m);
  if (value === true || (value && value.ok === true)) state.outcome = worst(state.outcome, "ok");
  else if (value === false || (value && value.ok === false)) {
    state.outcome = worst(state.outcome, "fail");
  } else if (value && value.__gxReply) {
    state.delivered = true;
    if (value.outcome) state.outcome = worst(state.outcome, value.outcome);
  }
  await emitSummary(m);
}

/** Note that an error template was delivered, then emit the summary. */
export async function finishError(m) {
  const state = stateOf(m);
  state.delivered = true;
  state.outcome = "fail";
  state.errorGiven = true;
  await emitSummary(m);
}

/**
 * Emit the single reaction that summarises the turn, or replay the held replies
 * when the outcome is inconclusive (e.g. a game question that gave no verdict).
 */
async function emitSummary(m) {
  const state = states.get(m);
  if (!state || state.replaying) return;
  if (state.reacted) return;
  if (!transformEnabled()) return;

  const react = async (kind, emoji = null) => {
    state.reacted = kind;
    try {
      await m.__reactRaw?.(emoji || emojiFor(kind));
    } catch {
      /* a reaction must never fail the command */
    }
  };

  /* super mode: a failure is the red reaction, whether or not an error template
     was suppressed (it never is in super mode, but keep this explicit) */
  if (state.super && state.outcome === "fail") {
    return react("fail");
  }

  /* an error template already told the user what went wrong */
  if (state.errorGiven) return;

  /* under super mode, held replies win when they give no verdict */
  if (state.super && state.hold.length) {
    const kind = state.outcome || classifyText(state.text);
    if (kind === "info") {
      state.replaying = true;
      try {
        for (const entry of state.hold) {
          if (!entry.player) continue;
          await entry.player(entry.text, entry.options);
        }
      } finally {
        state.replaying = false;
      }
      return;
    }
    await react(kind);
    return;
  }

  /* normal mode: a lone toast reply becomes the ✅ reaction */
  if (!state.super) {
    if (state.collapsed) return react("ok", collapseEmoji());
    if (state.delivered) return;
    /* a command that said nothing and did not throw still ran: ✅ */
    return react("ok", collapseEmoji());
  }

  /* super mode, nothing held: use the folded outcome */
  if (state.outcome) return react(state.outcome);
  /* a command that produced nothing at all still ran — the green light is the
     whole point of super mode (a denial returns earlier, from the gates) */
  if (!state.delivered && !state.hadMedia) return react("ok");
}

/* ─────────────────────────── handler context helper ─────────────────────────── */

/**
 * Explicit status API for plugins that want to control the outcome:
 *   `ctx.output.done("…")` / `.fail("…")` / `.keep("…")` / `.silent()`
 * Each behaves exactly like the matching `m.reply` variant after the turn.
 */
export function outputApi(m) {
  return {
    done: (text) => {
      markDelivered(m, "ok");
      return m.reply(text, { silentKind: "ok" });
    },
    fail: (text) => {
      markDelivered(m, "fail");
      return m.reply(text, { silentKind: "fail" });
    },
    keep: (text) => m.reply(text, { keep: true }),
    silent: () => markDelivered(m),
  };
}
