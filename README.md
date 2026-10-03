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
| **Utility** | `tts`, `translate`, `qr`, `calculator`, `shorten` |
| **Search / Info** | `search`, `ping`, `botinfo`, `owner`, `gempa` (BMKG) |
| **Game** | `catur`/`chess` (inline) |
| **Owner** | `mode`, `prefix`, `ban`, `unban` |

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

Missing menu/thumbnail assets fall back to a generated placeholder, so the UI
never breaks even with no media supplied.

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
│   ├── control-server.js    # in-bot control socket (for the console)
│   ├── control-client.js    # interactive console UI (separate process)
│   ├── control-utils.js     # shared console helpers
│   ├── log-bus.js           # mirrors logger output to the console
│   ├── xmpp/                # WhatsApp ↔ Minecraft bridge
│   │   ├── client.js        # persistent XMPP connection + backoff reconnect
│   │   ├── bridge.js        # text-only relay, filtering, loop & rate guards
│   │   └── manager.js       # singleton lifecycle + database-backed state
│   └── env.js               # .env loader
├── plugins/
│   ├── main/                # menu, allmenu
│   ├── altheora/            # dynamic document flow (+ _scanner.js, _registry.js)
│   ├── group/               # group management
│   ├── notes/               # notes
│   ├── sticker/             # sticker, toimage
│   ├── media/               # tomp3
│   ├── utility/             # tts, translate, qr, calculator, shorten
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
