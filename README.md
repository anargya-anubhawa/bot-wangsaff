# GX-ID

A modular WhatsApp bot built on [Baileys](https://github.com/Whiskeysockets/Baileys) (Multi-Device).
GX-ID follows a plugin + case architecture with a group-scoped notes system,
group management, media/sticker utilities, BMKG earthquake info and an inline
chess game.

---

## Table of Contents

- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Configuration](#configuration)
- [Authentication](#authentication)
- [Run the Bot](#run-the-bot)
- [Minecraft bridge (XMPP)](#minecraft-bridge-xmpp)
- [Document → PDF (`/pdf`)](#document--pdf-pdf)
- [PDF → document (`/unpdf`)](#pdf--document-unpdf)
- [Group links & shared features](#group-links--shared-features)
- [Plugin System](#plugin-system)
- [Creating a Plugin](#creating-a-plugin)
- [Commands](#commands)
- [Database](#database)
- [Troubleshooting](#troubleshooting)
- [Project Structure](#project-structure)

---

## Features

| Area | Commands |
| --- | --- |
| **Main** | `menu`, `help`, `allmenu` |
| **Group** | `tagall`, `hidetag`, `tagadmin`, `groupinfo`, `linkgc`, `revoke`, `setname`, `setdesc`, `open`, `close`, `promote`, `demote`, `kick`, `add` |
| **Notes** | `addnote`, `notes`, `delnote`, `#name` (lookup) |
| **Sticker** | `sticker`/`s`, `toimage` |
| **Media** | `tomp3` |
| **Utility** | `tts`, `translate`, `qr`, `calculator`, `shorten`, `pdf`, `unpdf` |
| **Search / Info** | `search`, `ping`, `botinfo`, `owner`, `gempa` (BMKG) |
| **Game** | `catur`/`chess` (inline) |
| **Owner** | `mode`, `prefix`, `ban`, `unban` |
| **Group setup** | `registergroup`, `unregistergroup`, `regcontrol`, `link`, `unlink`, `links`, `listreg` |
| **Schedule** | `schedule`, `schedules`, `unschedule`, `settimezone` |

Core mechanics:

- Multi-prefix command parsing (default `.`, plus custom prefixes).
- Permission system: owner / admin / group / private / bot-admin.
- Per-command cooldowns, anti-spam, bot mode (`public`/`self`).
- Channel/newsletter preview on menu & help messages.
- `#note` lookup is intercepted before command parsing.
- Errors are logged to the console (with stack traces) but never exposed to users.

---

## Requirements

- **Node.js ≥ 22** (uses the built-in `process.loadEnvFile`)
- npm (or pnpm/yarn)
- No system `ffmpeg` required — the bundled `@ffmpeg-installer/ffmpeg` is used.

---

## Installation

```bash
git clone <your-repo-url> GX-ID
cd GX-ID
npm install
```

Copy the example environment file and adjust it:

```bash
cp .env.example .env      # Windows: copy .env.example .env
```

---

## Configuration

All tunables live in two places:

1. **`.env`** — secrets and per-deployment values (see `.env.example`).
2. **`config.js`** — structural defaults, messages, feature toggles.

Key environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `BOT_NAME` | `GX-ID` | Bot display name |
| `OWNER_NAME` | `Owner` | Owner display name |
| `OWNER_NUMBER` | — | Comma-separated owner numbers (digits only) |
| `USE_PAIRING_CODE` | `true` | `true` = pairing code, `false` = QR |
| `PAIRING_NUMBER` | — | Number used for the pairing code |
| `BOT_MODE` | `public` | `public` or `self` |
| `PREFIX` | `.` | Default command prefix |
| `CHANNEL_ID` | — | Newsletter JID for the channel tag (empty = disabled) |
| `CHANNEL_NAME` | `GX-ID Channel` | Newsletter name |
| `CHANNEL_LINK` | — | Newsletter link |
| `ASSET_MENU` | `./media/menu.png` | Menu image (path or URL) |
| `ASSET_THUMB` | `./media/thumb.png` | Thumbnail (path or URL) |
| `DATABASE_PATH` | `./database/main` | Database directory |
| `SESSION_FOLDER` | `session` | Session folder under `./storage` |
| `NODE_ENV` | `production` | `development` enables extra debug logging |
| `MESSAGES_SILENT` | `true` | Silent mode default (suppress gate/refusal notices) |
| `APIKEY_*` | — | Third-party API keys (see below) |
| `TELEGRAM_BOT_TOKEN` | — | Telegram bot token (`.telestick`) |

Missing menu/thumbnail assets fall back to a generated placeholder, so the UI
never breaks even with no media supplied.

### API keys

Third-party credentials live in `.env` only — nothing is committed. Only the
keys the code actually uses are read; every one is optional and an empty value
disables just the feature that depends on it:

| Variable | Used by |
| --- | --- |
| `APIKEY_LOLHUMAN` | legacy `.API()` helper (`api.lolhuman.xyz`) |
| `APIKEY_NEOXR` | sticker `attp` + `smeme-animated` |
| `APIKEY_FGSI` | FGSI API provider |
| `APIKEY_COVENANT` | Covenant API provider |
| `APIKEY_CUKI` | Cuki API provider |
| `APIKEY_TERMAICDN` | image uploader key |
| `TERMAI_CDN_BASE` | image uploader host (default `https://c.termai.cc`) |
| `TELEGRAM_BOT_TOKEN` | `.telestick` (Telegram sticker download) |

Unused keys that shipped with the original GX-ID core (`google`, `betabotz`,
`onlym`, `obscura`, `firefly`, `xterm`, plus the `vercel` / `aquaApi` / `alight`
blocks) were removed from the code; their values are preserved, commented out,
in `.env.example` for reference.

### Silent mode

The notices the bot sends when it *refuses* or *cannot* run a command
(unknown command, command disabled, owner-only, group-only, admin-only,
cooldown, ban, unregistered group, anti-call, …) are controlled by a single
**silent mode** master switch. It can be set three ways, in order of precedence:

1. **`.silent on|off`** — runtime override, persisted in the database
   (`silentMode`). Owner-only; `.silent` with no argument reports the state.
2. **`config.messages.silent`** — the config default, optionally seeded from
   `MESSAGES_SILENT` in `.env`.
3. **`config.messages.enabled: false`** — legacy alias, still honoured.

```js
messages: {
  silent: true,         // true → suppress the notices (config default)
                        // false → send them
  onDisabled: "silent", // what to do while silent:
                        //   "silent" → send nothing
                        //   "react"  → react to the triggering message
  react: "🔒",          // emoji used when onDisabled is "react"
  // …
}
```

```text
.silent on     → suppress every gate/refusal notice
.silent off    → send them again
.silent        → show the current state
```

Functional output (`wait`, `success`, `error`, `genericError`) and the
bare-command usage/help cards are **never** silenced, so the bot still tells
users when something actually ran, failed, or needs parameters.

---

## Authentication

GX-ID supports **two** login methods.

### Pairing code (recommended)

1. Set in `.env`:

   ```env
   USE_PAIRING_CODE=true
   PAIRING_NUMBER=62812xxxxxxx
   ```

2. Start the bot (`npm start`).
3. An 8-character pairing code is printed in the terminal.
4. On your phone: **WhatsApp → Settings → Linked Devices → Link a Device →
   Link with phone number**, then enter the code.

If `PAIRING_NUMBER` is empty, the bot prompts for a number at startup.

### QR code

1. Set in `.env`:

   ```env
   USE_PAIRING_CODE=false
   PRINT_QR=true
   ```

2. Start the bot and scan the terminal QR with WhatsApp.

Session credentials are stored under `./storage/<SESSION_FOLDER>`. **Delete that
folder** to force a fresh login.

---

## Run the Bot

```bash
npm start          # run once
npm run dev        # run with --watch (auto restart on file changes)
npm run console    # interactive control console (in a SECOND terminal)
npm test           # run the smoke + pipeline tests
```

On a successful boot you will see the banner, database init, asset loading,
plugin registration and either the pairing code or QR.

### Interactive control console

The bot always prints plain logs to its own terminal. To drive it interactively,
open **another** terminal while the bot is running and start the console:

```bash
npm run console
```

It connects to the bot over a local control socket (a named pipe on Windows, a
unix socket elsewhere) and shows the bot's live log feed plus a persistent
footer with status (clock, uptime, ping, memory, groups, connection). From there
you can send a message to a group or private chat (and watch that chat's
incoming conversation), broadcast to all registered groups or a selected subset,
and restart or stop the bot. Because it is a separate process, it never
interferes with the bot's own logging.

Set `NO_CONSOLE=1` to disable the control socket, or `CONSOLE_PIPE=<path>` to use
a custom socket path.

---

## Minecraft bridge (XMPP)

The bot can relay text chat two-way between selected WhatsApp groups and a
Minecraft server, through **EssentialsXMPP + Prosody**:

```
Minecraft → EssentialsXMPP → Prosody → XMPP → WhatsApp bot → bridge group(s)
```

Only the groups you list are bridged, only **plain text** is relayed (images,
video, audio, voice notes, stickers, GIFs, documents, locations, contacts, polls,
reactions and statuses are all ignored), and the bridge never loops back on
itself. If the XMPP server is down the bot keeps running normally and reconnects
with exponential backoff.

### Setup

1. Copy the `XMPP_*` block from `.env.example` into `.env` and fill it in:

   ```env
   XMPP_ENABLED=true
   XMPP_HOST=xmpp.anargya.my.id
   XMPP_PORT=7777
   XMPP_DOMAIN=xmpp.anargya.my.id
   XMPP_USERNAME=minecraft
   XMPP_PASSWORD=your-secret
   # Where Minecraft chat goes: a MUC room, or a direct JID (XMPP_TO).
   XMPP_ROOM=
   XMPP_TO=
   ```

   All connection settings live in **`config/xmpp.js`** (the single source of
   truth) and are read from `.env` — credentials are never hardcoded elsewhere.

2. Start the bot. On boot you will see the XMPP lifecycle:

   ```
   [BOOT] Starting XMPP bridge…
   [XMPP] Connecting to xmpp.anargya.my.id:7777
   [XMPP] Connected
   [XMPP] Authenticated
   ```

3. Choose which WhatsApp groups are bridged, from inside each group:

   ```
   .xmpp setgroup     # bridge the current group
   .xmpp groups       # list bridge groups
   .xmpp on | off     # enable / disable the bridge (owner)
   .xmpp status       # connection status (never shows the password)
   ```

### Message flow

| Direction | WhatsApp shows | Minecraft shows |
| --- | --- | --- |
| Minecraft → WhatsApp | `⛏️ Minecraft`<br><br>`Steve: Halo guys` | — |
| WhatsApp → Minecraft | — | `[WA] Anargya: Halo Steve!` |

The WhatsApp sender name uses `pushName` (falling back to the number). Incoming
WhatsApp text is sanitised (formatting/markup removed, whitespace collapsed) and
truncated to `XMPP_MAX_LENGTH` so a long message never breaks Minecraft chat.
WhatsApp → Minecraft is rate limited (`XMPP_RATE_MAX` per `XMPP_RATE_WINDOW_MS`);
Minecraft → WhatsApp is never throttled.

The bridge is a self-contained module (`lib/xmpp/`); if the `@xmpp/client`
dependency is missing or XMPP is unreachable, WhatsApp still runs normally.

---

## Document → PDF (`/pdf`)

Reply to a document or image with `.pdf` (aliases `topdf`, `convertpdf`,
`jadipdf`) and the bot converts it **locally on the host** and sends the PDF
back to the chat. Nothing is uploaded anywhere.

| Input | Engine | Notes |
| --- | --- | --- |
| Office: `docx` `pptx` `xlsx` `odt` `rtf` `html` … | LibreOffice (headless) | Requires LibreOffice installed on the host |
| Images: `jpg` `png` `webp` `gif` `tiff` … | Built-in writer | No external dependency |
| Text: `txt` `md` `csv` `json` `log` … | Built-in writer | No external dependency |
| `pdf` | passthrough | Re-sent unchanged |

**LibreOffice is auto-detected, never installed.** The bot looks for `soffice`
on `PATH` and in the usual install locations. If it is missing, Office files are
rejected with an actionable message while images and text still convert. Point
the bot at a specific binary with `LIBREOFFICE_PATH`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `LIBREOFFICE_PATH` | *(auto)* | Explicit path to the `soffice` binary |
| `PDF_MAX_SIZE_MB` | `25` | Maximum accepted input size |
| `PDF_TIMEOUT_MS` | `90000` | Conversion timeout |

Limits are read live from `.env` (so they hot-reload) and mirrored in
`config.pdf`. The engine lives in `lib/pdf-convert.js`; the dependency-free PDF
writer (text layout + embedded JPEG) lives in `lib/pdf-writer.js`.

---

## PDF → document (`/unpdf`)

The inverse of `.pdf`. Reply to a PDF with `.unpdf` (aliases `frompdf`, `pdf2`,
`pdfconvert`, `unpdf2docx`) and the bot answers with an **interactive button
sheet** of target formats. Tap one and the converted file is sent back — all
locally, nothing uploaded.

| Target | Engine | Notes |
| --- | --- | --- |
| `docx` | Built-in | Real OOXML package — opens in Word/LibreOffice/Docs |
| `txt`, `md`, `html`, `rtf` | Built-in | Re-encoded from the extracted text |
| `png`, `jpg` | LibreOffice (headless) | First page rendered as an image |

Pass the format directly to skip the picker: `.unpdf docx` (or `txt`, `md`,
`html`, `rtf`, `png`, `jpg`).

**Text extraction is dependency-free** (`lib/pdf-reader.js`): it inflates the
content streams (`zlib`), merges compressed object streams, walks the page tree
and replays the text operators. It handles ordinary *born-digital* PDFs. A
**scanned / image-only** PDF carries no text — text targets then reply with an
actionable message instead of an empty file, while `png`/`jpg` still work
because they rasterise rather than read. Encrypted PDFs are detected and
reported. DOCX output is assembled by `lib/docx-writer.js` on top of the
dependency-free ZIP writer in `lib/zip-writer.js`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PDF_JOB_TTL_SECONDS` | `900` | How long a format picker stays valid |
| `PDF_JOB_MAX` | `50` | Pending conversions kept in memory at once |

The picked PDF is downloaded once and held in memory under a short-lived token
(`lib/pdf-jobs.js`) until a row is tapped; the token is bound to the chat that
minted it, so it cannot be redeemed elsewhere. Conversion runs only on tap, so
an ignored picker costs nothing.

---

## Group links & shared features

Groups can be linked so they share data without duplicating it. A link does not
copy anything — it makes the groups resolve to one **scope id**, and the shared
feature is stored under that id.

```text
.link <grup>                      → this chat manages <grup> (control panel)
.link <grup-a> <grup-b>           → peer link (either may manage the other)
.link <fitur> <grup-a> <grup-b>   → share one feature between two groups
.unlink <fitur> <a> <b>           → stop sharing that feature
.links [grup|all]                 → show a group's links (or every link)
```

Shareable features (`SCOPE_FEATURES` in `lib/group-scope.js`):

| Feature | Shared behaviour |
| --- | --- |
| `notes` | One note store for every linked group |
| `filters` | One auto-reply filter set |
| `blacklist` | One blacklist |
| `schedule` | One schedule set — each entry **fires in every linked group** |
| `general` | Reserved general-purpose scope |

### Shared schedules

Schedules are stored per delivery target (`jid`). Linking two groups for the
`schedule` feature makes the scheduler fan a schedule out to **all** groups that
share the scope, exactly like the reserved `global` keyword but limited to the
linked set:

```text
.link schedule kelas-a kelas-b     → share schedules
.schedule 08:00 daily              → reply a message, then create it
# fires at 08:00 in BOTH kelas-a and kelas-b
.unlink schedule kelas-a kelas-b   → stop the fan-out (own-group delivery stays)
```

- `.schedule list <grup>` shows the group's own schedules, the global ones and
  every shared one; shared entries are marked `⇄` and the header lists the
  linked groups.
- `.schedule list all` (owner) groups shared schedules under one section.
- Deleting a shared schedule is allowed from any group in the scope.

---

## Plugin System

Plugins live under `plugins/<category>/<file>.js`. On boot, `lib/plugins.js`
walks that directory, imports each file and registers it in a command/alias/
category store.

Two plugin shapes are supported.

### 1. Modern (preferred)

```js
export const pluginConfig = {
  name: "ping",
  alias: ["p"],
  category: "info",
  description: "Check latency",
  usage: ".ping",
  example: ".ping",
  isOwner: false,
  isGroup: false,
  isAdmin: false,
  isBotAdmin: false,
  cooldown: 3,
  isEnabled: true,
};

async function handler(m, ctx) {
  await m.reply("pong");
}

export { pluginConfig as config, handler };
```

### 2. Legacy (default export with metadata)

```js
async function handler(m, ctx) {
  await m.reply("pong");
}

handler.command = /^(ping|pong)$/i;
handler.help = ["ping"];
handler.tags = ["info"];
handler.group = false;
handler.admin = false;
export default handler;
```

Plugin config fields:

| Field | Type | Description |
| --- | --- | --- |
| `name` | string | Primary command name (required) |
| `alias` | string[] | Alternative names |
| `category` | string | Menu category |
| `description` | string | Short description |
| `usage` / `example` | string | Help text |
| `isOwner` | boolean | Owner only |
| `isPremium` | boolean | Premium only |
| `isGroup` | boolean | Group only |
| `isPrivate` | boolean | Private only |
| `isAdmin` | boolean | Requires group admin |
| `isBotAdmin` | boolean | Requires the bot to be admin |
| `cooldown` | number | Seconds between uses (per user) |
| `isEnabled` | boolean | Whether the command is active |

### Handler context

Every handler receives `(m, ctx)`:

| Property | Description |
| --- | --- |
| `m` | Serialized message (see below) |
| `ctx.sock` | Baileys socket (with GX-ID extensions) |
| `ctx.args` | Array of arguments |
| `ctx.text` | Argument text after the command |
| `ctx.command` | Matched command name |
| `ctx.prefix` | Prefix used |
| `ctx.config` | Global config |
| `ctx.db` | Database instance |
| `ctx.uptime` | Bot uptime (ms) |
| `ctx.plugins.count` | Number of loaded plugins |

Useful `m` helpers: `m.reply()`, `m.replyImage()`, `m.replyAudio()`,
`m.replySticker()`, `m.replyDocument()`, `m.react()`, `m.download()`,
`m.delete()`, plus flags `m.isGroup`, `m.isOwner`, `m.isAdmin`, `m.isBotAdmin`,
`m.isQuoted`, `m.quoted`, `m.mentionedJid`.

---

## Creating a Plugin

1. Create a file, e.g. `plugins/utility/echo.js`:

   ```js
   export const pluginConfig = {
     name: "echo",
     alias: ["say"],
     category: "utility",
     description: "Repeat your text",
     usage: ".echo <text>",
     example: ".echo hello",
     cooldown: 3,
     isEnabled: true,
   };

   async function handler(m) {
     if (!m.text) return m.reply("Usage: .echo <text>");
     await m.reply(m.text);
   }

   export { pluginConfig as config, handler };
   ```

2. Restart the bot (or use `npm run dev`). The plugin is auto-registered and
   appears under `utility` in `menu` / `allmenu`.

---

## Commands

### Main

- `menu` / `help` — image menu with a single `single_select` category list; tap a category to open it.
- `allmenu <category>` — list commands in a category.

### Altheora

- `altheora` / `al` — native-flow document menu (one selector per folder under `assets/altheora`).
  Tap a row to receive the PDF; categories and files are discovered from disk (no hardcoding).

### Group management

All group commands require the bot to be an admin where noted.

- `tagall [msg]` — tag every member (admin).
- `hidetag [msg]` — mention everyone invisibly (admin).
- `tagadmin [msg]` — tag admins only (admin).
- `groupinfo` — detailed group info.
- `linkgc` — get the invite link (admin).
- `revoke` — reset the invite link (admin).
- `setname <name>` — change group name (admin).
- `setdesc <text>` — change description (admin).
- `open` / `close` — open/close the group (admin).
- `promote` / `demote` — manage admins (admin).
- `kick` — remove a member (admin).
- `add <number…> [link]` — add members (admin).

### Notes (group-scoped)

- `addnote <name> <content>` — save a note.
- `#<name>` — display a note (intercepted before parsing).
- `notes` — list notes.
- `delnote <name>` — delete a note.

### Schedule

- `schedule [grup] <HH:MM> <daily|weekly <hari>|once <dd.mm.yyyy>>` — reply a
  message to send it later (alias `add`/`set`).
- `schedules [grup|global|all]` — list schedules.
- `unschedule [grup|global] <id>` — delete a schedule.
- `settimezone <zona>` — set the IANA timezone (owner).
- Share schedules across groups with `.link schedule <a> <b>` (see
  [Group links & shared features](#group-links--shared-features)).

### Sticker / media

- `sticker` / `s` — make a sticker from an image/video.
- `toimage` — convert a sticker to an image.
- `tomp3` — extract audio from a video/voice note.

### Utility

- `tts <lang> <text>` — text to speech voice note.
- `translate <lang> <text>` — translate text.
- `qr <text>` — generate a QR code.
- `calculator <expr>` — evaluate a math expression.
- `shorten <url>` — shorten a URL.
- `pdf` / `topdf` / `convertpdf` — convert a replied document/image to PDF.
- `unpdf` / `frompdf` / `pdf2` — convert a replied PDF to DOCX/TXT/MD/HTML/RTF (or PNG/JPG) via an interactive button sheet.

### Search / Info

- `search <query>` — web search.
- `ping` — latency & uptime.
- `botinfo` — bot information.
- `owner` — owner contact.
- `gempa` — latest BMKG earthquake info.

### Game

- `catur` / `chess` — inline chess game (vs bot or 2 players).

### Owner

- `mode <public|self>` — switch bot mode.
- `silent <on|off>` — toggle silent mode (suppress gate/refusal notices).
- `prefix [add|del] <char>` — manage prefixes.
- `ban` / `unban` — manage banned users.
- `xmpp [status|groups|on|off|setgroup|unsetgroup]` — control the Minecraft bridge.

---

## Database

GX-ID uses [lowdb](https://github.com/typicode/lowdb) with one JSON file per
concern, stored in `DATABASE_PATH` (default `./database/main`):

| File | Contents |
| --- | --- |
| `users.json` | Users, premium/ban flags, cooldowns |
| `groups.json` | Per-group settings |
| `settings.json` | Global settings (mode, prefixes, bans) |
| `stats.json` | Counters |
| `notes.json` | Group-scoped notes |

Writes are **atomic** (temp file + rename) and dirty stores are flushed every
5 seconds and on exit. Corrupt files are backed up (`.corrupted.<ts>.bak`) and
reset automatically.

The database API (via `ctx.db`):

```js
db.getUser(jid); db.setUser(jid, { name }); db.getUserCount();
db.checkCooldown(jid, cmd, seconds); db.setCooldown(jid, cmd, seconds);
db.getGroup(jid); db.setGroup(jid, { welcome: true });
db.getNote(scope, name); db.setNote(scope, name, content, by);
db.listNotes(scope); db.deleteNote(scope, name);
db.setting(key, value?); db.incrementStat(key);
```

---

## Troubleshooting

**`npm.ps1` cannot be loaded / execution policy error (Windows)**
Use `npm.cmd` instead of `npm`, or run PowerShell as administrator and set
`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

**Bot keeps disconnecting / "Session Conflict" (440)**
Another instance is running with the same session. Stop the other bot. For
`401`/`loggedOut`, delete `./storage/<SESSION_FOLDER>` and log in again.

**No QR / pairing code appears**
Ensure `USE_PAIRING_CODE` and `PRINT_QR` are set correctly, and that the
terminal supports ANSI output. Check your internet connection.

**Sticker conversion fails**
The bundled ffmpeg is used automatically. If it is missing, reinstall
dependencies (`npm install`). Video stickers are capped at 6 seconds.

**Menu image missing**
Add `media/menu.png` and `media/thumb.png`, or set `ASSET_MENU`/`ASSET_THUMB`.
If absent, a placeholder is generated automatically.

**`#note` does nothing**
Notes are scoped to the chat: a group note must be looked up in the same group.

**Command does nothing in a group**
The bot may not be an admin (for admin commands), or the bot is in `self` mode.
Check with `.botinfo` and `.mode`.

---

## Project Structure

```
GX-ID/
├── index.js                 # entry point (boot sequence)
├── console.js               # control console launcher (separate terminal)
├── config.js                # global configuration
├── config/
│   └── xmpp.js              # XMPP bridge config (single source of truth)
├── .env.example
├── core/
│   ├── connection.js        # Baileys socket, auth, reconnect, events
│   └── message.js           # message pipeline & dispatch
├── case/
│   └── index.js             # inline case commands
├── lib/
│   ├── logger.js            # [GX-ID][TAG] logger
│   ├── database.js          # lowdb multi-file store
│   ├── serialize.js         # message serializer + command parser
│   ├── plugins.js           # plugin loader & registry
│   ├── middleware.js        # permission & mode checks
│   ├── flow.js              # native-flow builder & sender (shared UI layer)
│   ├── flow-router.js       # central native-flow action router
│   ├── socket.js            # socket extensions (sticker/media/etc.)
│   ├── sticker.js           # sticker/media conversion (bundled ffmpeg)
│   ├── context.js           # channel preview & fake quotes
│   ├── asset-manager.js     # asset loading + placeholders
│   ├── formatter.js         # text formatting helpers
│   ├── group-utils.js       # group helpers
│   ├── lid.js               # LID ↔ JID mapping
│   ├── time.js              # Asia/Jakarta time helpers
│   ├── error.js             # user-facing error template
│   ├── messages.js          # silent mode + feedback-message switch
│   ├── control-server.js    # in-bot control socket (for the console)
│   ├── control-client.js    # interactive console UI (separate process)
│   ├── control-utils.js     # shared console helpers
│   ├── log-bus.js           # mirrors logger output to the console
│   ├── xmpp/                # WhatsApp ↔ Minecraft bridge
│   │   ├── client.js        # persistent XMPP connection + backoff reconnect
│   │   ├── bridge.js        # text-only relay, filtering, loop & rate guards
│   │   └── manager.js       # singleton lifecycle + database-backed state
│   ├── pdf-convert.js       # document/image → PDF engine (LibreOffice + built-in)
│   ├── pdf-writer.js        # dependency-free PDF builder (text + embedded JPEG)
│   ├── pdf-reader.js        # dependency-free PDF text extractor
│   ├── pdf-export.js        # PDF → docx/txt/md/html/rtf/png/jpg engine
│   ├── pdf-jobs.js          # short-lived store for pending PDF conversions
│   ├── docx-writer.js       # dependency-free DOCX (OOXML) builder
│   ├── zip-writer.js        # dependency-free ZIP writer (used by DOCX)
│   └── env.js               # .env loader
├── plugins/
│   ├── main/                # menu, allmenu
│   ├── altheora/            # dynamic document flow (+ _scanner.js, _registry.js)
│   ├── group/               # group management
│   ├── notes/               # notes
│   ├── sticker/             # sticker, toimage
│   ├── media/               # tomp3
│   ├── utility/             # tts, translate, qr, calculator, shorten, pdf, unpdf
│   ├── search/              # search
│   ├── info/                # ping, botinfo, owner, gempa
│   ├── game/                # catur
│   └── owner/               # mode, prefix, ban, unban, xmpp bridge
├── media/                   # menu/thumbnail assets
├── database/                # runtime data
└── storage/                 # session + temp files
```

---

## License

ISC
