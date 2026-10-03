/**
 * GX-ID — /help
 *
 * Metadata-driven help. There is no hardcoded command list: everything is read
 * from the live plugin registry (`lib/help.js`).
 *
 *   .help            → category drill-down (Native Flow)
 *   .help <command>  → detail card for one command
 *
 * The flow drill-down uses one namespace, `help`:
 *   help:cat:<category>   → list that category's commands
 *   help:cmd:<command>    → show a command's detail card
 *   help:page:<n>         → paginate a category
 */
import { registerFlowRoute } from "../../lib/flow-router.js";
import { sendNativeFlow, createSingleSelect, paginate, MAX_FLOW_ROWS } from "../../lib/flow.js";
import {
  listCategories,
  commandsInCategory,
  buildCommandHelp,
  buildOverviewBody,
  categoryEmoji,
  categoryTitle,
} from "../../lib/help.js";
import { getPluginCount } from "../../lib/plugins.js";

const pluginConfig = {
  name: "help",
  alias: ["panduan", "bantu"],
  category: "utility",
  description: "Tampilkan daftar perintah & detailnya",
  usage: ".help [command]",
  examples: [".help", ".help sticker"],
  permission: "all",
  cooldown: 3,
  isEnabled: true,
};

function fallbackOverview(prefix) {
  const cats = listCategories();
  const lines = cats.map((c) => `┃ ${c.emoji} ${categoryTitle(c.category)} — ${c.count}`).join("\n");
  return (
    `📖 *BANTUAN*\n\n╭─〔 kategori 〕\n${lines}\n╰─⬣\n\n` +
    `> Detail: \`${prefix}help <command>\`\n> ${cats.length} kategori · ${getPluginCount()} perintah`
  );
}

async function sendCategoryFlow(namespace, m, ctx, category, page = 0) {
  const cmds = commandsInCategory(category);
  const pageData = paginate(cmds, page, MAX_FLOW_ROWS);

  const buttons = [];
  const mainSelect = createSingleSelect({
    title: categoryTitle(category).slice(0, 64),
    sectionTitle: categoryTitle(category).slice(0, 64),
    rows: pageData.items.map((c) => ({
      id: `help:cmd:${c.name}`,
      title: `.${c.name}`,
      description: (c.description || "").slice(0, 60),
    })),
  });
  buttons.push(mainSelect);

  if (pageData.totalPages > 1) {
    const navRows = [];
    if (pageData.hasPrev) navRows.push({ id: `help:cat:${category}:${pageData.page - 1}`, title: "« Sebelumnya" });
    if (pageData.hasNext) navRows.push({ id: `help:cat:${category}:${pageData.page + 1}`, title: "Berikutnya »" });
    navRows.push({ id: "help:cat:__all__", title: "« Semua kategori" });
    buttons.push(createSingleSelect({ title: "Navigasi", rows: navRows }));
  } else {
    buttons.push(
      createSingleSelect({
        title: "Navigasi",
        rows: [{ id: "help:cat:__all__", title: "« Semua kategori" }],
      }),
    );
  }

  const header =
    `${categoryEmoji(category)} *${categoryTitle(category)}* (${cmds.length})` +
    (pageData.totalPages > 1 ? `\n\n> Halaman ${pageData.page + 1}/${pageData.totalPages}` : "");

  return sendNativeFlow(ctx.sock, m.chat, {
    body: header,
    footer: "Ketuk untuk melihat detail",
    buttons,
    quoted: m.raw,
    fallbackLabel: "help",
  });
}

async function sendOverviewFlow(m, ctx, prefix) {
  const cats = listCategories();
  const pageData = paginate(cats, 0, MAX_FLOW_ROWS);
  const mainSelect = createSingleSelect({
    title: "Kategori",
    sectionTitle: "Kategori",
    rows: pageData.items.map((c) => ({
      id: `help:cat:${c.category}`,
      title: `${c.emoji} ${categoryTitle(c.category)}`,
      description: `${c.count} perintah`,
    })),
  });
  const buttons = [mainSelect];
  if (pageData.totalPages > 1) {
    const navRows = [];
    if (pageData.hasNext) navRows.push({ id: "help:page:1", title: "Berikutnya »" });
    buttons.push(createSingleSelect({ title: "Navigasi", rows: navRows }));
  }
  return sendNativeFlow(ctx.sock, m.chat, {
    body: buildOverviewBody(prefix, getPluginCount(), cats.length),
    footer: "Ketuk untuk membuka kategori",
    buttons,
    quoted: m.raw,
    fallbackLabel: "help",
  });
}

async function sendOverviewPage(m, ctx, prefix, page) {
  const cats = listCategories();
  const pageData = paginate(cats, page, MAX_FLOW_ROWS);
  const buttons = [
    createSingleSelect({
      title: "Kategori",
      sectionTitle: "Kategori",
      rows: pageData.items.map((c) => ({
        id: `help:cat:${c.category}`,
        title: `${c.emoji} ${categoryTitle(c.category)}`,
        description: `${c.count} perintah`,
      })),
    }),
  ];
  const navRows = [];
  if (pageData.hasPrev) navRows.push({ id: `help:page:${pageData.page - 1}`, title: "« Sebelumnya" });
  if (pageData.hasNext) navRows.push({ id: `help:page:${pageData.page + 1}`, title: "Berikutnya »" });
  if (navRows.length) buttons.push(createSingleSelect({ title: "Navigasi", rows: navRows }));

  return sendNativeFlow(ctx.sock, m.chat, {
    body: buildOverviewBody(prefix, getPluginCount(), cats.length) + `\n\n> Halaman ${pageData.page + 1}/${pageData.totalPages}`,
    footer: "Ketuk untuk membuka kategori",
    buttons,
    quoted: m.raw,
    fallbackLabel: "help",
  });
}

/* ─────────────────────────── flow route ─────────────────────────── */

registerFlowRoute("help", async (m, ctx, action) => {
  const prefix = m.prefix || ctx.config?.command?.prefix || ".";
  const [kind, ...rest] = [action.action, ...action.args];

  if (kind === "cmd") {
    const name = rest[0];
    const detail = buildCommandHelp(name, prefix);
    if (!detail) {
      await m.reply(`❓ Perintah \`${name}\` tidak ditemukan.`);
      return true;
    }
    await m.reply(detail);
    return true;
  }

  if (kind === "cat") {
    const category = rest[0];
    const page = Number(rest[1]) || 0;
    if (!category || category === "__all__") {
      await sendOverviewPage(m, ctx, prefix, page);
      return true;
    }
    const sent = await sendCategoryFlow("help", m, ctx, category, page);
    if (!sent) {
      const cmds = commandsInCategory(category);
      await m.reply(
        `${categoryEmoji(category)} *${categoryTitle(category)}*\n\n${cmds.map((c) => `┃ \`.${c.name}\` — ${c.description}`).join("\n")}`,
      );
    }
    return true;
  }

  if (kind === "page") {
    await sendOverviewPage(m, ctx, prefix, Number(rest[0]) || 0);
    return true;
  }

  return false;
});

/* ─────────────────────────── handler ─────────────────────────── */

async function handler(m, ctx) {
  const prefix = m.prefix || ctx.config?.command?.prefix || ".";
  const target = (m.args?.[0] || "").toLowerCase().replace(/^[./]/, "");

  if (target) {
    const detail = buildCommandHelp(target, prefix);
    if (!detail) {
      await m.reply(`❓ Perintah \`${target}\` tidak ditemukan.\n\n> Lihat semua: \`${prefix}help\``);
      return;
    }
    await m.reply(detail);
    return;
  }

  const sent = await sendOverviewFlow(m, ctx, prefix);
  if (!sent) await m.reply(fallbackOverview(prefix));
}

export { pluginConfig as config, handler };
