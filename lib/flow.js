/**
 * GX-ID — Native Flow builder & sender
 *
 * A single reusable layer for WhatsApp *native flow* interactive messages
 * (the `interactiveMessage` → `nativeFlowMessage` → `single_select` pattern).
 * Both `.menu` and `.altheora` are built with these helpers so the JSON is
 * never written twice.
 *
 * Compatibility: upstream @whiskeysockets/baileys v7 exposes
 * `proto.Message.InteractiveMessage` with `header` / `body` / `footer` /
 * `nativeFlowMessage{ buttons[], messageParamsJson }`. There is NO `sendFlow()`
 * helper — interactive messages are relayed through `sock.relayMessage` with
 * the `biz`/`interactive`/`native_flow` binary nodes (`interactiveRelayNodes`)
 * and a 32-byte `messageSecret` (`interactiveContextInfo`), otherwise WhatsApp
 * silently drops the stanza.
 */
import { logger } from "./logger.js";
import { interactiveContextInfo, saluranCtx } from "./context.js";
import { interactiveRelayNodes } from "./socket.js";

/* ─────────────────────────── limits (single source of truth) ─────────────────────────── */

/**
 * Maximum rows allowed in one `single_select` section before pagination kicks
 * in. Evidence: the reference payload shipped by the user renders a section
 * with 34 rows, so WhatsApp/Baileys v7 accepts at least that many; we paginate
 * comfortably below the observed ceiling to keep the bottom sheet usable.
 */
export const MAX_FLOW_ROWS = 30;

/**
 * Maximum `single_select` buttons placed in one `nativeFlowMessage`. Evidence:
 * the reference payload carries 9 real selectors plus a leading
 * `{"has_multiple_buttons":true}` marker (10 buttons total). Extra categories
 * are paginated behind a nav button.
 */
export const MAX_FLOW_BUTTONS = 9;

/** Safety caps for row text (clients truncate long strings unpredictably). */
export const MAX_TITLE_LENGTH = 64;
export const MAX_DESCRIPTION_LENGTH = 64;
export const MAX_ID_LENGTH = 96;

/* ─────────────────────────── sanitization ─────────────────────────── */

/** Collapse whitespace and hard-truncate a display string. */
export function clampText(value, max) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/**
 * Normalise a flow id to the safe `[a-z0-9:_-]` alphabet used by the router.
 * Ids are namespaced (`altheora:file:sop:sop-akademik`) so this only removes
 * characters that would break the id grammar — it never invents a path.
 */
export function sanitizeId(value) {
  const id = String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return id.slice(0, MAX_ID_LENGTH) || "x";
}

/**
 * Turn a list of `{ id, title, description }` items into flow rows with
 * sanitized text and guaranteed-unique ids.
 *
 * @param {Array<{id:string,title:string,description?:string}>} items
 * @param {{seen?:Set<string>}} [options]
 * @returns {Array<{title:string,description:string,id:string}>}
 */
export function createFlowRows(items = [], options = {}) {
  const seen = options.seen instanceof Set ? options.seen : new Set();
  const rows = [];
  for (const item of items) {
    if (!item) continue;
    let id = sanitizeId(item.id);
    if (seen.has(id)) {
      let n = 2;
      const base = id;
      while (seen.has(`${base}-${n}`)) n++;
      id = `${base}-${n}`;
    }
    seen.add(id);
    rows.push({
      title: clampText(item.title, MAX_TITLE_LENGTH) || "Item",
      description: clampText(item.description, MAX_DESCRIPTION_LENGTH),
      id,
    });
  }
  return rows;
}

/* ─────────────────────────── builders ─────────────────────────── */

/**
 * Build one `single_select` button.
 * @param {{title:string, sectionTitle?:string, highlightLabel?:string, rows?:Array, sections?:Array}} params
 */
export function createSingleSelect({ title, sectionTitle, highlightLabel, rows, sections } = {}) {
  const payload = { title: clampText(title, MAX_TITLE_LENGTH) || "Select" };
  if (Array.isArray(sections)) {
    payload.sections = sections;
  } else {
    const section = { title: clampText(sectionTitle || title, MAX_TITLE_LENGTH) || "Options" };
    if (highlightLabel) section.highlight_label = clampText(highlightLabel, MAX_TITLE_LENGTH);
    section.rows = createFlowRows(rows);
    payload.sections = [section];
  }
  return { name: "single_select", buttonParamsJson: JSON.stringify(payload) };
}

/**
 * Assemble a `nativeFlowMessage`.
 * When more than one `single_select` is present the reference pattern adds a
 * leading `{"has_multiple_buttons":true}` marker so the client renders them as
 * a multi-selector sheet.
 *
 * @param {{buttons:Array, messageParamsJson?:string, markMultiple?:boolean}} params
 */
export function createNativeFlowMessage({ buttons = [], messageParamsJson, markMultiple = true } = {}) {
  const list = [...buttons];
  const selectCount = list.filter((b) => b?.name === "single_select").length;
  const finalButtons =
    markMultiple && selectCount > 1
      ? [{ name: "single_select", buttonParamsJson: JSON.stringify({ has_multiple_buttons: true }) }, ...list]
      : list;
  const out = { buttons: finalButtons };
  if (messageParamsJson) out.messageParamsJson = messageParamsJson;
  return out;
}

/**
 * Build the `messageParamsJson` for the bottom sheet UI. Only the widely
 * supported keys are emitted; unknown client features are omitted rather than
 * risking a dropped message.
 */
export function buildMessageParams({ listTitle, buttonTitle, dividerIndices, inThreadButtonsLimit } = {}) {
  const bottom_sheet = {};
  if (Number.isFinite(inThreadButtonsLimit)) bottom_sheet.in_thread_buttons_limit = inThreadButtonsLimit;
  if (Array.isArray(dividerIndices)) bottom_sheet.divider_indices = dividerIndices;
  if (listTitle) bottom_sheet.list_title = clampText(listTitle, MAX_TITLE_LENGTH);
  if (buttonTitle) bottom_sheet.button_title = clampText(buttonTitle, MAX_TITLE_LENGTH);
  return JSON.stringify({ bottom_sheet });
}

/* ─────────────────────────── pagination ─────────────────────────── */

/**
 * Slice a list into a page.
 * @returns {{items:Array, page:number, totalPages:number, hasPrev:boolean, hasNext:boolean}}
 */
export function paginate(items = [], page = 0, size = MAX_FLOW_ROWS) {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(0, Number(page) || 0), totalPages - 1);
  return {
    items: items.slice(current * size, current * size + size),
    page: current,
    totalPages,
    hasPrev: current > 0,
    hasNext: current < totalPages - 1,
  };
}

/* ─────────────────────────── sender ─────────────────────────── */

/**
 * Relay a native-flow interactive message (optional image header + body +
 * footer + flow buttons). Returns `true` when the relay succeeded and `false`
 * when it threw, so callers can fall back to a legacy text/list menu.
 *
 * @param {object} sock
 * @param {string} jid
 * @param {{image?:Buffer, headerTitle?:string, headerSubtitle?:string, body:string,
 *          footer?:string, buttons:Array, messageParamsJson?:string,
 *          quoted?:object, mentionedJid?:Array<string>, contextInfo?:object,
 *          markMultiple?:boolean, fallbackLabel?:string}} opts
 * @returns {Promise<boolean>}
 */
export async function sendNativeFlow(sock, jid, opts = {}) {
  const {
    image,
    headerTitle = "",
    headerSubtitle = "",
    body = "",
    footer = "",
    buttons = [],
    messageParamsJson,
    quoted,
    mentionedJid = [],
    contextInfo = {},
    markMultiple = true,
    fallbackLabel = "menu",
  } = opts;

  const flow = createNativeFlowMessage({ buttons, messageParamsJson, markMultiple });

  let imageMessage;
  if (image) {
    try {
      const media = await sock.prepareMedia({ image });
      imageMessage = media?.imageMessage;
    } catch (error) {
      logger.warn(`[FLOW] media prep failed (${fallbackLabel}): ${error.message}`);
    }
  }

  const header = { title: headerTitle, subtitle: headerSubtitle, hasMediaAttachment: !!imageMessage };
  if (imageMessage) header.imageMessage = imageMessage;

  const content = {
    viewOnceMessage: {
      message: {
        messageContextInfo: interactiveContextInfo(),
        interactiveMessage: {
          header,
          body: { text: body },
          footer: { text: footer },
          contextInfo: { ...saluranCtx(), mentionedJid, ...contextInfo },
          nativeFlowMessage: flow,
        },
      },
    },
  };

  try {
    await sock.relayMessage(jid, content, {
      quoted,
      additionalNodes: interactiveRelayNodes(jid),
    });
    return true;
  } catch (error) {
    logger.error(`[FLOW] failed (${fallbackLabel}): ${error.message}`);
    logger.warn("[FALLBACK] using legacy menu");
    return false;
  }
}
