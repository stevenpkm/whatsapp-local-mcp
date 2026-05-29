# WhatsApp MCP for Claude

Read your own WhatsApp messages from inside Claude. Ask things like *"summarize my last 12 hours of WhatsApp"* or *"who's waiting on a reply?"*, and Claude reads, searches, transcribes voice notes, and looks at images for you.

✅ Runs **100% locally** on your computer &nbsp;·&nbsp; 🔒 **Read-only** — it can never send messages &nbsp;·&nbsp; 💬 Works with **Cowork** and **Claude Desktop**

---

## ⚡ Quick start (Cowork — easiest, no terminal)

**Most people should use this.** You need two things:

- **Node.js 18+** — if you don't have it, get it from [nodejs.org](https://nodejs.org/) (just click Next → Next → Install, takes a minute).
- **A phone with WhatsApp** to scan a QR code once.

Then open Cowork and **paste this whole block into the chat:**

````
Hi Claude. Please install the WhatsApp MCP for me.

Important: Use the folder you already have access to in this chat. Do NOT ask me to select a new folder — I already granted you a folder when I set up Cowork.

Repo: https://github.com/stevenpkm/whatsapp-local-mcp

Please do this:
1. In bash, figure out the path of the folder you already have access to, then cd into it.
2. Run: git clone https://github.com/stevenpkm/whatsapp-local-mcp.git
3. Tell me clearly: "Go to <full path>/whatsapp-local-mcp/windows/ and double-click install.bat. A black window will open and run for 2–3 minutes — it downloads dependencies and patches the Cowork config. When it says SUCCESS, close it."
4. Wait for me to confirm it's done. Then tell me to fully quit Cowork (right-click the tray icon, choose Quit — NOT just close the window) and reopen it.
5. After I reopen and say "scan":
   a. Call mcp__whatsapp__relink_whatsapp (the bridge will generate a fresh QR).
   b. Tell me EXACTLY: "On your Desktop, double-click 'Open WhatsApp QR'. A big QR will open in your browser. Scan it from your phone: WhatsApp → Settings → Linked Devices → Link a Device. The page auto-refreshes if the QR expires, and shows '✓ Connected' once linked."
   c. Do NOT try to render the QR inline in chat. Always send me to the Desktop shortcut.

Rules:
- Do NOT call request_cowork_directory.
- Do NOT ask me to select a new folder.
- Do NOT use computer-use for anything.
- Do NOT open File Explorer, terminals, or any other windows on my screen.
- Use only bash and your file tools.
- When you need me to do something, tell me the exact path clearly.

Begin now.
````

That's it — Cowork's Claude walks you through the rest. The flow:

1. It clones the project and tells you to double-click **`install.bat`** (a black window runs ~2–3 minutes, then says **SUCCESS**). The installer also drops an **"Open WhatsApp QR"** shortcut on your Desktop.
2. *(If Windows shows "Windows protected your PC" → click **More info → Run anyway**.)*
3. **Fully quit Cowork** from the tray (right-click → Quit, not just close the window) and reopen it.
4. Type **`scan my WhatsApp`**. Double-click **"Open WhatsApp QR"** on your Desktop, and scan it from your phone (WhatsApp → Settings → Linked Devices → Link a Device). It shows **✓ Connected** when done.

Now try: *"summarize my WhatsApp from the last 12 hours"* 🎉

> *(Optional) Want voice notes turned into text? You can add an OpenAI API key later — see "What it costs" below.*

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

### Claude Desktop (no Cowork)

1. Install **Node.js 18+** from [nodejs.org](https://nodejs.org/).
2. Open a terminal in a stable folder (e.g. `Documents`):
   ```
   git clone https://github.com/stevenpkm/whatsapp-local-mcp.git
   cd whatsapp-local-mcp
   ```
3. Double-click `windows\install.bat`. It runs `npm install` and writes a `whatsapp` entry into `%APPDATA%\Claude\claude_desktop_config.json` so Claude knows to launch the MCP server.
4. *(Optional)* For voice-note transcription, create `api-key.txt` in the repo root and paste your OpenAI key (one line, no quotes).
5. Quit and reopen Claude Desktop.
6. In chat, type **`scan my WhatsApp`** and scan the QR on your phone.

### macOS / Linux

The Windows `.bat` helpers don't run here, but the Node code is cross-platform.

```bash
git clone https://github.com/stevenpkm/whatsapp-local-mcp.git
cd whatsapp-local-mcp
npm install
node scripts/install-mcp-config.mjs   # patches the config
```

On macOS the Claude config lives at `~/Library/Application Support/Claude/claude_desktop_config.json`. The install script targets Windows `APPDATA` by default — on macOS, edit the config manually:

```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "node",
      "args": ["/absolute/path/to/whatsapp-local-mcp/src/index.js"]
    }
  }
}
```

For the bridge to survive across sessions on macOS/Linux, run `node src/bridge.js` in a launchctl/systemd unit (the Windows `.bat` handles spawning automatically).

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

Splitting the bridge from the MCP server is the whole trick — Claude Desktop crashes and restarts don't break the WhatsApp link.

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
| Brief text analysis | Your Claude subscription | ~5–15K tokens per brief |

A typical daily brief over an active 12h WhatsApp window: a few cents on OpenAI + some Claude tokens.

To enable voice-note transcription, get an OpenAI API key at [platform.openai.com/api-keys](https://platform.openai.com/api-keys) and paste it into `api-key.txt` in the project root (one line, no quotes).

</details>

<details>
<summary><b>🔒 Privacy & security</b></summary>

- **Everything stays local** by default. Cache lives in `data\store.json`. Auth lives in `auth\`.
- The bridge connects only to WhatsApp's own servers via the [Baileys](https://github.com/WhiskeySockets/Baileys) library (open source).
- When you ask Claude a question, only the specific messages relevant to that question are sent to Anthropic's servers as part of your normal Claude conversation.
- If you enable Whisper transcription, voice-note audio bytes are sent to OpenAI for transcription, then the transcript is cached locally. After that, the audio is not re-sent.
- **No `send_message` tool exists by design** — this MCP cannot send anything on your behalf, which significantly cuts down the prompt-injection blast radius.
- **Don't share `auth/` or `api-key.txt`** — they're sensitive. `.gitignore` excludes them by default.
- **WhatsApp ToS gray area:** WhatsApp's official Terms of Service do not explicitly authorize third-party clients via Baileys-style multi-device automation. Read-only personal use has historically not been targeted, but there is no guarantee — use at your own risk.

</details>

<details>
<summary><b>⚙️ All the tools (for developers)</b></summary>

**Read tools (cache-only, free):**
- `get_status` — connection + cache health
- `list_chats` — all chats with names (not IDs)
- `get_recent_messages` — last N hours, filterable by chat / group
- `search_messages` — case-insensitive substring search
- `get_brief` / `set_brief` — read/write the daily brief artifact JSON

**Media tools (lazy, on-demand):**
- `get_image` — return image bytes inline so Claude can SEE the picture (vision)
- `set_description` — cache Claude's description of an image
- `save_image` — write a single image to disk; returns absolute path
- `save_voice` — write a single voice note (.ogg) to disk; optionally also transcribe via Whisper
- `save_media` — generic save (image/audio/video/document) when the kind isn't known in advance
- `list_media_window` — read-only preview of what `save_media_window` would save (with `likelyExpired` flag for media older than ~13 days)
- `save_media_window` — bulk save from the last N hours with bounded concurrency and per-item results
- `where_do_media_files_go` — return the default folder path and how many files are already in it
- `enrich_window` — voice-only: download + transcribe voice notes via Whisper (no images — those go through `get_image`)

**Link management:**
- `relink_whatsapp` — start a fresh QR pair
- `wait_for_link` — block until the link succeeds
- `force_resync` — soft reconnect

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
whatsapp-mcp/
  README.md                          <- you are here
  LICENSE                            <- MIT
  .gitignore                         <- excludes auth/, data/, api-key.txt
  package.json

  src/
    bridge.js                        <- always-on WhatsApp connection
    index.js                         <- MCP server (thin HTTP client)
    whatsapp.js                      <- Baileys controller + watchdog
    store.js                         <- message cache (with .backup)
    transcribe.js                    <- OpenAI Whisper client

  scripts/
    install-mcp-config.mjs           <- writes claude_desktop_config.json

  windows/                           <- Windows helper .bat files
    install.bat                      <- first-time install
    restart-bridge.bat               <- restart bridge after code change
    reset.bat                        <- nuclear: wipe auth + cache

  auth/        (gitignored)          <- WhatsApp credentials. DON'T SHARE.
  data/        (gitignored)          <- local message cache + brief.json
  api-key.txt  (gitignored)          <- OpenAI key for voice transcription
```

</details>

<details>
<summary><b>🚑 Troubleshooting</b></summary>

**Claude says "MCP whatsapp: server disconnected"**
Click `windows\restart-bridge.bat` to kill the old bridge and start a fresh one. The MCP server in Claude will reconnect on next tool call. If it persists, check `data\bridge.log`.

**My phone shows the device "last active" stuck at some old time, even though Claude says connected**
The WebSocket has gone zombie — TCP socket still open, but no real traffic. The bridge's keepalive + watchdog should auto-fix in ~3 minutes. If not, run `windows\restart-bridge.bat`.

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

1. Confirm the user has Node 18+ installed (`node --version` via Bash/Terminal). If not, point them to https://nodejs.org/.
2. Have them clone this repo to a stable path (anywhere except temp folders).
3. Have them double-click `windows\install.bat` (or run the equivalent on macOS/Linux: `npm install` + `node scripts/install-mcp-config.mjs`).
4. Confirm `%APPDATA%\Claude\claude_desktop_config.json` now contains an `mcpServers.whatsapp` entry pointing at this project's `src/index.js`. If not, edit it manually.
5. Optionally, ask the user for an OpenAI API key for voice transcription. Tell them to paste it directly into `api-key.txt` in the repo root — do not ask them to share it in chat.
6. Tell them to quit and reopen Claude Desktop / Cowork.
7. Once back in chat, call the MCP tool `relink_whatsapp` to generate a fresh QR. **Do NOT try to render the QR inline in chat** — it is unreliable. Instead, send the user to the live QR page in their browser:
   - **Windows:** "Double-click the **Open WhatsApp QR** shortcut on your Desktop." (the installer created it)
   - **Any OS:** "Open **http://127.0.0.1:8765/qr** in your browser."
   The page renders a big, scannable QR, auto-refreshes when it expires, and shows **✓ Connected** once linked. Tell them to scan from WhatsApp → Settings → Linked Devices → Link a Device.
8. After the user scans, call `wait_for_link` to confirm.
9. Verify with `get_status` that `connected: true`.

From here, normal queries like "summarize my last 12 hours" will work.

</details>

---

## License

MIT — see `LICENSE`. Built on [@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys) and the [Model Context Protocol SDK](https://github.com/modelcontextprotocol).
