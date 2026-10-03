/**
 * GX-ID — reusable "flow list" helper
 *
 * Several commands (`notes`, `filters`, `schedules`, `blacklists`, `links`,
 * `help`) present a list whose items are actionable. Instead of sending one
 * message per item, they render a single Native Flow bottom sheet and route
 * taps back through `lib/flow-router.js`.
 *
 * This helper owns the boilerplate: pagination, row ids, the "nav" rows
 * (prev/next/close) and a per-namespace route handler that resolves a row id
 * back to its item. A plugin only supplies the items and what to do on tap.
 */
import { sendNativeFlow, createSingleSelect, paginate, MAX_FLOW_ROWS, MAX_FLOW_BUTTONS } from "./flow.js";
import { registerFlowRoute } from "./flow-router.js";
import { logger } from "./logger.js";

/** Registry of active list flows: namespace → { build, onSelect }. */
const flows = new Map();

/**
 * Register a list flow.
 *
 * @param {object} opts
 * @param {string} opts.namespace       flow namespace (a-z0-9_-)
 * @param {(m:object, ctx:object) => Promise<{title:string, items:Array<{id:string,title:string,description?:string}>}>} opts.build
 *        Produces the header title + the full item list for the invoking chat.
 * @param {(m:object, ctx:object, item:object) => Promise<void>} opts.onSelect
 *        Called when a row is tapped; `item` is the matched item (or a nav item).
 */
export function registerListFlow({ namespace, build, onSelect }) {
  const ns = String(namespace || "").toLowerCase();
  if (!ns || typeof build !== "function" || typeof onSelect !== "function") return false;
  flows.set(ns, { build, onSelect });

  registerFlowRoute(ns, async (m, ctx, action) => {
    const flow = flows.get(ns);
    if (!flow) return false;

    // action: <ns>:<page|select|close>[:arg]
    if (action.action === "close") {
      return true;
    }
    if (action.action === "select") {
      // Rows carry the item's positional index, not its raw id: flow ids must
      // survive the `[a-z0-9:_-]` sanitizer and the router's `:` splitting, and
      // item ids (e.g. a `re:` regex trigger) legitimately contain both `:` and
      // other characters that would otherwise be mangled.
      const index = Number(action.args[0]);
      const { items } = await flow.build(m, ctx);
      const item = Number.isInteger(index) ? items[index] : undefined;
      if (!item) return false;
      await flow.onSelect(m, ctx, item);
      return true;
    }
    // Any other action re-renders the list (page navigation).
    const page = Number(action.args[0]) || 0;
    await sendListFlow(ns, m, ctx, page);
    return true;
  });
  return true;
}

/** Render page `page` of a registered list flow. Returns true on success. */
export async function sendListFlow(namespace, m, ctx, page = 0) {
  const flow = flows.get(String(namespace || "").toLowerCase());
  if (!flow) return false;

  let built;
  try {
    built = await flow.build(m, ctx);
  } catch (error) {
    logger.error(`[flow-list] build "${namespace}" failed: ${error.message}`);
    return false;
  }
  const { title = "List", body = "", footer = "", items = [], buttons } = built || {};
  if (!items.length) {
    // Nothing to list: send the (empty-state) body once and report "handled"
    // so callers don't send their own fallback on top of it.
    const text = body || `📋 *${title}*`;
    await ctx.sock.sendMessage(m.chat, { text }, { quoted: m.raw }).catch(() => {});
    return true;
  }

  const pageData = paginate(items, page, MAX_FLOW_ROWS);

  // Build extra nav buttons (paginated lists put prev/next in their own
  // selectors so the main selector stays purely "items").
  const extraButtons = [];
  if (buttons && Array.isArray(buttons)) {
    for (const group of buttons.slice(0, MAX_FLOW_BUTTONS - 1)) {
      extraButtons.push(createSingleSelect({ title: group.title, rows: group.rows }));
    }
  }
  if (pageData.totalPages > 1) {
    const navRows = [];
    if (pageData.hasPrev) navRows.push({ id: `${namespace}:page:${pageData.page - 1}`, title: "« Sebelumnya" });
    if (pageData.hasNext) navRows.push({ id: `${namespace}:page:${pageData.page + 1}`, title: "Berikutnya »" });
    if (navRows.length) extraButtons.push(createSingleSelect({ title: "Navigasi", rows: navRows }));
  }

  const mainSelect = createSingleSelect({
    title: title.slice(0, 64),
    sectionTitle: title.slice(0, 64),
    rows: pageData.items.map((i, idx) => ({
      id: `${namespace}:select:${pageData.page * MAX_FLOW_ROWS + idx}`,
      title: i.title,
      description: i.description,
    })),
  });

  const headerText =
    `${body || `📋 *${title}*`}` +
    (pageData.totalPages > 1 ? `\n\n> Halaman ${pageData.page + 1}/${pageData.totalPages}` : "");

  return sendNativeFlow(ctx.sock, m.chat, {
    body: headerText,
    footer: footer || "Ketuk untuk memilih",
    buttons: [mainSelect, ...extraButtons],
    quoted: m.raw,
    fallbackLabel: `list:${namespace}`,
  });
}
