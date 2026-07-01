# WhatsApp MCP for Claude

Read your own WhatsApp messages from inside Claude. Ask things like *"summarize my last 12 hours of WhatsApp"* or *"who's waiting on a reply?"*, and Claude reads, searches, transcribes voice notes, and looks at images for you.

✅ Runs **100% locally** on your computer &nbsp;·&nbsp; 🔒 **Read-only** - it can never send messages &nbsp;·&nbsp; 💬 Works with **Cowork** and **Claude Desktop**

---

## ⚡ Quick start (Cowork - easiest, no terminal)

**Most people should use this.** You need two things:

- **Node.js 18+** - if you don't have it, get it from [nodejs.org](https://nodejs.org/) (just click Next → Next → Install, takes a minute).
- **A phone with WhatsApp** to scan a QR code once.

Then open Cowork and **paste this whole block into the chat:**

````
Hi Claude. Please install the WhatsApp MCP for me. I'm NOT technical. The only things I'll
do are: double-click one installer file, restart Cowork, and scan a QR with my phone.

Repo: https://github.com/stevenpkm/whatsapp-local-mcp

Important: your sandbox CANNOT register the MCP or start it on Windows - only INSTALL.bat
(which I double-click on Windows) can. So your job is to get the files into my folder and
hand me the installer. Do this in order:

1. Put the project into the folder I gave you access to in this chat (use THAT folder, don't
   pick another, don't worry whether it's OneDrive). Get the SOURCE only - do NOT run
   `npm install` and do NOT copy node_modules (the installer does that so the native binaries
   are correct). Easiest: download the zip and extract it here -
       https://github.com/stevenpkm/whatsapp-local-mcp/archive/refs/heads/main.zip
   (the contents land in a "whatsapp-local-mcp-main" folder). If a direct `git clone` into my
   folder fails - some synced/mounted folders block git's file locking - that's expected: use
   the zip, or clone into a temp dir and copy the files in (skip .git and node_modules).

2. Do NOT use computer-use, and do NOT open Explorer/Finder or any app yourself. Just tell me,
   in plain text, the full path of that folder and to double-click INSTALL.bat (Windows) or
   INSTALL.command (Mac) inside it. A window runs ~2-5 min - it checks Node (if Node is
   missing it opens nodejs.org for me, and I re-run it after installing), installs
   dependencies, and registers the MCP, then says SUCCESS. If Windows warns "protected your
   PC", I click More info -> Run anyway; on Mac if it won't run, I right-click it -> Open.

3. Wait for me to say the installer finished. Then tell me to FULLY quit Cowork (tray /
   menu-bar icon -> Quit, NOT just close the window) and reopen it. Approve the tools prompt
   if one appears.

4. After I reopen and say "scan": call mcp__whatsapp__relink_whatsapp, then send me to the
   live page http://127.0.0.1:8765/qr (open it in your inline browser / preview, or tell me to
   open that URL in my own browser). Do NOT paste the QR as an image - the live page
   auto-refreshes when it expires and shows "Connected" when done. I scan from WhatsApp ->
   Settings -> Linked Devices -> Link a Device.

5. Verify: call mcp__whatsapp__wait_for_link, then mcp__whatsapp__get_status. Confirm
   connected: true, then tell me to try: "summarize my WhatsApp from the last 12 hours".

If any step fails, tell me exactly what failed and what you'll try next.

Begin now.
````

That's it. The flow:

1. Claude downloads the project into your folder and tells you the folder path (it won't use computer-use or open windows for you).
2. **Double-click `INSTALL.bat`** in that folder. A black window runs ~2-5 min (checks Node, installs dependencies, registers the MCP), then says **SUCCESS**. (If Windows warns "protected your PC", click **More info → Run anyway**.)
3. **Fully quit Cowork** from the tray (right-click → Quit, not just close the window) and reopen it. Approve the tools prompt if one appears.
4. Type **`scan my WhatsApp`**. Claude shows the QR **right in the sidebar** - scan it from your phone (WhatsApp → Settings → Linked Devices → Link a Device). Shows **✓ Connected** when done.

Now try: *"summarize my WhatsApp from the last 12 hours"* 🎉

> *(Optional) Want voice notes turned into text? You can add an OpenAI API key later - see "What it costs" below.*

---

## 💬 What you can ask

| You say | What Claude does |
|---|---|
| *"what's my WhatsApp status?"* | checks the connection + cache health |
| *"list my WhatsApp chats"* | shows all your chats by name |
| *"summarize my last 12 hours of WhatsApp"* | transcribes voice notes, looks at images, and writes you a brief |
| *"search WhatsApp for invoice"* | searches your local message history |
| *"what was Aaron's image at 3 pm about?"* | finds the image and looks at it for you |
| *"re-link my WhatsApp"* | shows a fresh QR to scan |
| *"my phone says it's disconnected"* | reconnects |

---

<details>
<summary><b>🛠️ Other ways to install (Claude Desktop · macOS / Linux)</b></summary>

### Claude Desktop (Windows)

1. Install **Node.js 18+** from [nodejs.org](https://nodejs.org/).
2. Get the project into a stable folder (e.g. `Documents`) - clone it, or download the zip and unzip:
   ```
   git clone https://github.com/stevenpkm/whatsapp-local-mcp.git
   ```
3. **Double-click `INSTALL.bat`** in the project folder. It runs `npm install` and writes a `whatsapp` entry into `%APPDATA%\Claude\claude_desktop_config.json` so Claude knows to launch the MCP server.
4. *(Optional)* For voice-note transcription, create `api-key.txt` in the repo root and paste your OpenAI key (one line, no quotes).
5. **Fully quit** Claude Desktop (tray icon → Quit, not just close the window) and reopen it.
6. In chat, type **`scan my WhatsApp`** and scan the QR on your phone.

### macOS

The Node code is cross-platform, and macOS has its own one-click installer.

1. Install **Node.js 18+** from [nodejs.org](https://nodejs.org/) (download the LTS `.pkg`, open it, Install).
2. Get the project into a folder (clone it, or download the zip and unzip).
3. **Double-click `INSTALL.command`** in the project folder. It runs `npm install` and registers the MCP into `~/Library/Application Support/Claude/claude_desktop_config.json` (auto-detected - no manual editing).
   - If macOS blocks it ("unidentified developer", or it opens in a text editor instead of running): open **Terminal** (Spotlight → type *Terminal*), then paste `bash "` , drag `INSTALL.command` onto the window, type `"`, and press Enter.
4. *(Optional)* For voice transcription, put your OpenAI key in `api-key.txt` in the project root.
5. **Fully quit** Cowork / Claude Desktop - click its menu-bar icon and choose Quit (Cmd-Q from the window may leave it running in the menu bar), then reopen.
6. In chat, type **`scan my WhatsApp`** and scan the QR (the status page is `http://127.0.0.1:8765/`, or the QR page `http://127.0.0.1:8765/qr`).

The bridge auto-starts when Cowork launches the MCP and survives Cowork restarts (detached), same as Windows. `mac/restart-bridge.command` restarts it if needed; `mac/reset.command` wipes auth + cache.

### Linux

Same Node code; no `.command` wrapper, so run it manually:

```bash
git clone https://github.com/stevenpkm/whatsapp-local-mcp.git
cd whatsapp-local-mcp
npm install
node scripts/install-mcp-config.mjs   # writes ~/.config/Claude/claude_desktop_config.json
```

</details>

<details>
<summary><b>🧩 How it works (the 1-minute version)</b></summary>

```
+------------------------------------------------------------+
|  Your phone: WhatsApp  (the master account)                |
+--------------------------+---------------------------------+
                           |  WhatsApp multi-device protocol
                           v
+------------------------------------------------------------+
|  bridge.js  (always running, detached background process)  |
|  - Holds the WhatsApp WebSocket connection                 |
|  - Receives every message live -> caches text + media keys |
|  - Survives Claude Desktop / Cowork restarts               |
|  - PID-locked: only one bridge runs at a time              |
+--------------------------+---------------------------------+
                           |  HTTP localhost:8765
                           v
+------------------------------------------------------------+
|  index.js  (MCP server, spawned by Claude Desktop/Cowork)  |
|  - Thin HTTP client to the bridge                          |
|  - Exposes MCP tools to Claude                             |
+--------------------------+---------------------------------+
                           |  stdio MCP
                           v
+------------------------------------------------------------+
|  Claude (in chat)                                          |
|  - Calls MCP tools to read messages                        |
|  - Looks at images directly via Claude's vision            |
|  - Writes briefs back to disk for the artifact to render   |
+------------------------------------------------------------+
```

Splitting the bridge from the MCP server is the whole trick - Claude Desktop crashes and restarts don't break the WhatsApp link.

Image analysis uses **Claude's own vision** through your Claude subscription. No separate Anthropic API key needed.

</details>

<details>
<summary><b>💰 What it costs</b></summary>

Nothing happens automatically. You only pay when you explicitly ask Claude to do something:

| Activity | Where charged | Approx |
|---|---|---|
| Bridge running 24/7, receiving + caching messages | Free | --- |
| Text-only queries (search, list, status) | Free | --- |
| Voice-note transcription (Whisper) | OpenAI API | ~$0.001 per voice note |
| Image analysis (Claude vision) | Your Claude subscription | ~1.5K tokens per image |
| Brief text analysis | Your Claude subscription | ~5-15K tokens per brief |

A typical daily brief over an active 12h WhatsApp window: a few cents on OpenAI + some Claude tokens.

To enable voice-note transcription, get an OpenAI API key at [platform.openai.com/api-keys](https://platform.openai.com/api-keys) and paste it into `api-key.txt` in the project root (one line, no quotes).

</details>

<details>
<summary><b>🔒 Privacy & security</b></summary>

- **Everything stays local** by default. Cache lives in `data\store.json`. Auth lives in `auth\`.
- The bridge connects only to WhatsApp's own servers via the [Baileys](https://github.com/WhiskeySockets/Baileys) library (open source).
- When you ask Claude a question, only the specific messages relevant to that question are sent to Anthropic's servers as part of your normal Claude conversation.
- If you enable Whisper transcription, voice-note audio bytes are sent to OpenAI for transcription, then the transcript is cached locally. After that, the audio is not re-sent.
- **No `send_message` tool exists by design** - this MCP cannot send anything on your behalf, which significantly cuts down the prompt-injection blast radius.
- **Don't share `auth/` or `api-key.txt`** - they're sensitive. `.gitignore` excludes them by default.
- **WhatsApp ToS gray area:** WhatsApp's official Terms of Service do not explicitly authorize third-party clients via Baileys-style multi-device automation. Read-only personal use has historically not been targeted, but there is no guarantee - use at your own risk.

</details>

<details>
<summary><b>⚙️ All the tools (for developers)</b></summary>

**Read tools (cache-only, free):**
- `get_status` - connection + cache health
- `list_chats` - all chats with names (not IDs)
- `get_recent_messages` - last N hours, filterable by chat / group
- `search_messages` - case-insensitive substring search
- `get_brief` / `set_brief` - read/write the daily brief artifact JSON

**Media tools (lazy, on-demand):**
- `get_image` - return image bytes inline so Claude can SEE the picture (vision)
- `set_description` - cache Claude's description of an image
- `save_image` - write a single image to disk; returns absolute path
- `save_voice` - write a single voice note (.ogg) to disk; optionally also transcribe via Whisper
- `save_media` - generic save (image/audio/video/document) when the kind isn't known in advance
- `list_media_window` - read-only preview of what `save_media_window` would save (with `likelyExpired` flag for media older than ~13 days)
- `save_media_window` - bulk save from the last N hours with bounded concurrency and per-item results
- `where_do_media_files_go` - return the default folder path and how many files are already in it
- `enrich_window` - voice-only: download + transcribe voice notes via Whisper (no images - those go through `get_image`)

**Link management:**
- `relink_whatsapp` - start a fresh QR pair
- `wait_for_link` - block until the link succeeds
- `force_resync` - soft reconnect

**Error contract:** every tool returns a structured envelope. Success: `{ ok: true, ...data }`. Failure: `{ ok: false, code, error, ...context }` where `code` is one of a closed set (`media_expired`, `no_keys`, `download_failed`, `not_found`, `not_image`, `disk_error`, `permission_denied`, `disk_full`, `bridge_unreachable`, `bridge_restarting`, `timeout`, `transcribe_failed`, `no_api_key`, `invalid_argument`, ...). The MCP response sets `isError: true` on failure so spec-compliant clients can branch without parsing strings. Bulk operations (`save_media_window`) return `ok: true` even when some items fail; failures appear inside `items[].ok = false` and are rolled up in `errors: [{code, count}]`.

**Saved-file paths.** Save tools also emit an MCP `resource_link` content block with `uri: file:///…` and the file's mime type, so capable clients can offer "open this file" affordances.

**Default folder.** Save tools write to `<project>/data/media/<YYYY-MM-DD>/` by default. Filename format: `<ISO-timestamp>__<chat-slug>__<sender-slug>__<msgId-tail>.<ext>`. Override the folder per call with the `folder` parameter (absolute path).

</details>

<details>
<summary><b>🔧 Configuration (environment variables)</b></summary>

| Var | Default | Meaning |
|---|---|---|
| `WHATSAPP_BRIDGE_PORT` | `8765` | Local HTTP port the bridge listens on |
| `WHATSAPP_HISTORY_DAYS` | `30` | Drop history-sync messages older than this many days |
| `WHATSAPP_VOICE_MAX_SECONDS` | `300` | Skip voice notes longer than this when transcribing |
| `WHATSAPP_STALE_MS` | `180000` | Force reconnect if no socket activity in this long |
| `OPENAI_API_KEY` | (none) | Used by Whisper. Falls back to `api-key.txt` in repo root. |

</details>

<details>
<summary><b>📁 File layout</b></summary>

```
whatsapp-local-mcp/
  README.md                          <- you are here
  LICENSE                            <- MIT
  .gitignore                         <- excludes auth/, data/, api-key.txt
  .gitattributes                     <- keeps .command LF, .bat CRLF
  package.json
  INSTALL.bat                        <- Windows: double-click to install
  INSTALL.command                    <- macOS: double-click to install

  src/
    bridge.js                        <- always-on WhatsApp connection + status dashboard
    index.js                         <- MCP server (thin HTTP client)
    whatsapp.js                      <- Baileys controller + reconnect/watchdog
    store.js                         <- message cache (with .backup)
    media-paths.js                   <- filename/folder helpers for saved media
    errors.js                        <- shared error-code envelope
    transcribe.js                    <- OpenAI Whisper client (voice notes)

  scripts/
    install-mcp-config.mjs           <- registers the MCP in the Claude/Cowork config
    doctor.mjs                       <- one-shot health check (node / registration / bridge)

  windows/                           <- Windows helper .bat files
    install.bat                      <- runs npm install + registers the MCP
    restart-bridge.bat               <- restart the bridge
    reset.bat                        <- nuclear: wipe auth + cache

  mac/                               <- macOS helper .command files
    install.command                  <- runs npm install + registers the MCP
    restart-bridge.command           <- restart the bridge
    reset.command                    <- nuclear: wipe auth + cache

  auth/        (gitignored)          <- WhatsApp credentials. DON'T SHARE.
  data/        (gitignored)          <- local message cache + brief.json + bridge.log
  api-key.txt  (gitignored)          <- OpenAI key for voice transcription
```

</details>

<details>
<summary><b>🚑 Troubleshooting</b></summary>

**Claude says "MCP whatsapp: server disconnected"**
Click `windows\restart-bridge.bat` to kill the old bridge and start a fresh one. The MCP server in Claude will reconnect on next tool call. If it persists, check `data\bridge.log`.

**My phone shows the device "last active" stuck at some old time, even though Claude says connected**
The WebSocket has gone zombie - TCP socket still open, but no real traffic. The bridge's keepalive + watchdog should auto-fix in ~3 minutes. If not, run `windows\restart-bridge.bat`.

**440 / "stream conflict" errors**
Another linked device (or a stale one) is claiming the slot. On your phone: WhatsApp → Settings → Linked Devices → log out everything that isn't your current entry. Then ask Claude to "re-link my WhatsApp".

**`get_image` says "no media keys stored"**
The message was cached before this code added media-key tracking. Only images received **after** the bridge restart with media-key support can be downloaded. Tomorrow's images will work.

**`get_image` says "download failed"**
Most likely the image is more than ~14 days old and WhatsApp's CDN has garbage-collected the encrypted blob. The media key is still valid, but the bytes are gone.

**I want to nuke everything and start over**
`windows\reset.bat`. Confirms with "YES", stops bridge, wipes `auth\` and `data\`.

</details>

<details>
<summary><b>🤖 Notes for the Claude assistant (if you paste this README into a chat)</b></summary>

*(This section is written for Claude itself, in case the user pastes this README into a chat and asks Claude to install the project.)*

Your sandbox CANNOT register the MCP (it can't write Cowork's protected global config, and Cowork does NOT read a project `.mcp.json`) and CANNOT start a Windows process. So you can't finish the install yourself - the last mile is the user double-clicking `INSTALL.bat` on Windows. Your job: get the source into their folder and hand off.

1. Put the SOURCE into the folder the user already granted this session - do NOT run `npm install` and do NOT copy `node_modules` (a sandbox-built one has the wrong native binaries; the installer builds them on the host). Prefer the zip (`https://github.com/stevenpkm/whatsapp-local-mcp/archive/refs/heads/main.zip`); if a direct `git clone` into a synced/mounted folder fails on lock/unlink, that's expected - use the zip, or clone to a temp dir and copy the source in (skip `.git` and `node_modules`).
2. Do NOT use computer-use, and do NOT open Explorer/Finder or any app. Just give them, in plain text, the folder's full path and tell them to double-click `INSTALL.bat` (Windows) or `INSTALL.command` (Mac). The installer checks Node on the host (opening nodejs.org if it's missing or too old), runs `npm install`, registers the MCP, then says SUCCESS. Don't run `node --version` yourself - your sandbox's Node isn't the user's machine's Node, so it proves nothing; the installer is the real check. (If SmartScreen/Gatekeeper warns: Windows More info → Run anyway; Mac right-click → Open.)
3. After they say it finished, tell them to **fully quit** Cowork (tray / menu-bar → Quit) and reopen. Approve the MCP-trust prompt if it appears.
4. Once back, call `relink_whatsapp`, then send them to the live page `http://127.0.0.1:8765/qr` (open it in your inline browser/preview, or have them open the URL). Do NOT paste the QR as an image - the live page auto-refreshes when it expires and shows Connected once linked. They scan from WhatsApp → Settings → Linked Devices → Link a Device.
5. Call `wait_for_link`, then `get_status` to confirm `connected: true`.
6. (Optional) For voice transcription, have them paste an OpenAI key into `api-key.txt` in the project root - never in chat.

A quick `node scripts/doctor.mjs` prints Node version, whether the global config has the entry, bridge reachability on 8765, and connection status - use it to check state instead of guessing.

From here, normal queries like "summarize my last 12 hours" work.

</details>

---

## License

MIT - see `LICENSE`. Built on [@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys) and the [Model Context Protocol SDK](https://github.com/modelcontextprotocol).
