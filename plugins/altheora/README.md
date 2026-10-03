# Altheora — dynamic document delivery (native flow)

`altheora` serves documents straight from disk as a WhatsApp **native flow**
interactive message. **Nothing is hardcoded**: folders become categories, files
become rows, and the whole flow is rebuilt from the filesystem on every
invocation. Add a folder or a PDF and it shows up instantly — no restart.

## Command

| Command | Effect |
| --- | --- |
| `.altheora` | Show the native-flow document menu (alias: `.al`) |
| `.altheora get <category> <key>` | Send a document directly (legacy text fallback) |
| `.altheora dir <category> <node>` | List a node's contents (legacy text fallback) |
| `.altheora cat` | List categories as text (legacy text fallback) |

You normally never type the sub-commands — tapping a flow row sends the
document directly. Row ids are namespaced (`altheora:file:<cat>:<key>`) and
resolved server-side.

## Native flow UI

One message, no navigation spam:

```
.altheora
  → 📚 ALTHEORA
      [ 📄 SOP        ]   ← one single_select per category
      [ 📅 KALENDER   ]      rows are that category's files
      [ 📜 TATA TERTIB]
  → tap a file row → the PDF is sent as a new document message
```

- Multiple `single_select` buttons live in one `nativeFlowMessage` (with the
  reference `{"has_multiple_buttons":true}` marker).
- Large categories are paginated inside their own selector
  (`MAX_FLOW_ROWS`); many categories paginate the button list
  (`MAX_FLOW_BUTTONS`).
- Optional per-category icon/title overrides live in `CATEGORY_META`; discovery
  is always automatic.

## Asset directory

```
assets/altheora/
├── SOP/                      ← a category (folder name = display name)
│   ├── SOP Evaluasi.pdf
│   └── ...
├── KALENDER/
│   └── ...
└── TATA TERTIB/
    ├── Tata Tertib Ujian.pdf
    └── ...
```

- **Folder** → category. Original name (spaces, capitals, numbers) is kept.
- **File** → document row. Nested sub-folders are supported and flattened into
  the category selector with a `Folder › File` breadcrumb title.
- Supported extensions: `.pdf` `.doc` `.docx` `.ppt` `.pptx` `.xls` `.xlsx`
  `.jpg` `.jpeg` `.png`. Extend `SUPPORTED_TYPES` in `_scanner.js` for more.
- Files are always sent **locally** — no re-download, no hosting, original
  filename preserved.

## Safety & robustness

- **Path security** — user input is never used as a path. The flow id is looked
  up in the server-side registry and re-validated through `getSafePath()`,
  which rejects anything escaping `assets/altheora` (no `../`, no absolute
  reads). Absolute paths are never sent to WhatsApp.
- **Stateless** — the flow ids carry the full selection, so two users in the
  same group can never receive each other's files. No per-user state is stored.
- **Cached registry** — `_registry.js` caches metadata keyed by a directory
  signature (mtime + entry count) so a tap does not walk the tree; the cache
  auto-invalidates when the tree changes. PDF contents are never cached.
- **Graceful errors** — missing folder, missing/deleted file, permission denied,
  oversized file, unsupported type and send failure all produce a clear message
  instead of crashing.
- **Fallback** — if the native-flow send fails, the menu degrades to a plain
  text listing (`[FLOW] failed …` / `[FALLBACK] using legacy menu`).

## Files

| File | Purpose |
| --- | --- |
| `altheora.js` | Plugin entry: `pluginConfig`, flow views, sending, flow route |
| `_scanner.js` | Filesystem scanning, slug keys, path containment, mime map |
| `_registry.js` | Cached asset registry + flattened file list |

The `_` prefix keeps the helper files out of the plugin loader (it skips
`_`-prefixed files), so only `altheora.js` is registered as a command.

## Shared flow layer

The flow UI is built with the reusable helpers in `lib/flow.js`
(`sendNativeFlow`, `createSingleSelect`, `createFlowRows`, `paginate`,
`MAX_FLOW_ROWS`, `buildMessageParams`) and dispatched through the central
router in `lib/flow-router.js`. `.altheora` is the native-flow consumer;
`.menu` keeps the usual single-`single_select` category list (it reuses the
same relay helpers, not the flow router).
