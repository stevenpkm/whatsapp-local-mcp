# WhatsApp MCP for Claude

A read-only WhatsApp bridge that gives Claude (Anthropic) access to your personal WhatsApp messages, so you can ask things like:

- *"summarize my last 12 hours of WhatsApp"*
- *"what was that picture Aaron sent at 3 pm?"*
- *"who's waiting on a reply?"*
- *"search WhatsApp for invoice"*

It runs **locally on your computer**. Your messages never leave the machine except for the specific excerpts Claude needs to answer your question, and (optionally) audio bytes when you transcribe voice notes via Whisper.

---

## How it works (1-minute version)

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

---

## Requirements

- **Node.js 18+** ([download](https://nodejs.org/))
- **Claude Desktop** or **Claude Cowork** (the desktop app)
- A **phone with WhatsApp** that can scan a QR code
- *(Optional)* an **OpenAI API key** if you want voice-note transcription. Get one at [platform.openai.com/api-keys](https://platform.openai.com/api-keys). Costs ~$0.001 per voice note.

Image analysis uses **Claude's own vision** through your Claude subscription. No separate Anthropic API key needed.

---

## Install

Pick the option that matches you. **Most people want Option A.**

### Option A — Cowork user (easiest, no terminal)

If you use **Cowork** (Claude's desktop app), it already has access to one folder on your computer — the folder you picked when you first set up Cowork. We'll use that.

1. Make sure you have **Node.js 18+** installed. If not, get it from [nodejs.org](https://nodejs.org/) (Next-Next-Install, takes a minute).
2. Open Cowork and **paste this into the chat**:

   ````
   Hi Claude. Please install the WhatsApp MCP for me.

   Important: Use the folder you already have access to in this chat. Do NOT ask me to select a new folder — I already granted you a folder when I set up Cowork.

   Repo: https://github.com/stevenpkm/whatsapp-local-mcp

   Please do this:
   1. In bash, figure out the path of the folder you already have access to, then cd into it.
   2. Run: git clone https://github.com/stevenpkm/whatsapp-local-mcp.git
   3. Tell me clearly: "Go to <full path>/whatsapp-local-mcp/windows/ and double-click install.bat. A black window will open and run for 2–3 minutes — it downloads dependencies and patches the Cowork config. When it says SUCCESS, close it."
   4. Wait for me to confirm it's done. Then tell me to fully quit Cowork (right-click the tray icon, choose Quit — NOT just close the window) and reopen it.
   5. After I reopen and say "scan", call mcp__whatsapp__relink_whatsapp and show me the QR so I can scan with my phone (WhatsApp → Settings → Linked Devices → Link a Device).

   Rules:
   - Do NOT call request_cowork_directory.
   - Do NOT ask me to select a new folder.
   - Do NOT use computer-use for anything.
   - Do NOT open File Explorer, terminals, or any other windows on my screen.
   - Use only bash and your file tools.
   - When you need me to do something, tell me the exact path clearly.

   Begin now.
   ````

3. Cowork will clone the repo into your folder and tell you to open `…\whatsapp-local-mcp\windows\` and **double-click `install.bat`**. A black window will open and run for 2–3 minutes. **Don't close it early** — `npm install` looks idle for long stretches but is working. When the window shows "SUCCESS", close it.

   > If Windows shows "Windows protected your PC" when you double-click, click **More info → Run anyway**. That's normal for any new file.

4. Right-click the Cowork tray icon (next to the clock) and choose **Quit** (just closing the window isn't enough). Reopen Cowork.
5. In chat, type **`scan my WhatsApp`**. A QR code appears. On your phone: WhatsApp → Settings → Linked Devices → Link a Device → scan.

That's it. Try: *"summarize my WhatsApp from the last 12 hours"*.

---

### Option B — Claude Desktop user (no Cowork)

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

---

### Option C — macOS / Linux

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

---

## Day-to-day use

Just talk to Claude in chat:

| You say | Claude does |
|---|---|
| *"what's my WhatsApp status?"* | calls `get_status` |
| *"list my WhatsApp chats"* | calls `list_chats` |
| *"summarize my last 12 hours of WhatsApp"* | transcribes voice notes, looks at images, writes a brief, saves to `data/brief.json`. Reload the **WhatsApp Brief** artifact to read it. |
| *"search WhatsApp for invoice"* | substring search across your local cache |
| *"what was Aaron's image at 3 pm about?"* | finds the image, downloads it, looks at it with Claude vision |
| *"re-link my WhatsApp"* | renders a fresh QR for you to scan |
| *"my phone says it's disconnected"* | runs `force_resync` to reconnect |

---

## Costs

Nothing happens automatically. You only pay when you explicitly ask Claude to do something:

| Activity | Where charged | Approx |
|---|---|---|
| Bridge running 24/7, receiving + caching messages | Free | --- |
| Text-only queries (search, list, status) | Free | --- |
| Voice-note transcription (Whisper) | OpenAI API | ~$0.001 per voice note |
| Image analysis (Claude vision) | Your Claude subscription | ~1.5K tokens per image |
| Brief text analysis | Your Claude subscription | ~5-15K tokens per brief |

A typical daily brief over an active 12h WhatsApp window: a few cents on OpenAI + some Claude tokens.

---

## File layout

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

---

## MCP tools exposed

`get_status`, `list_chats`, `get_recent_messages`, `search_messages`,
`relink_whatsapp`, `wait_for_link`, `force_resync`,
`enrich_window` (voice-only, calls Whisper),
`get_image` (returns image bytes for Claude vision),
`set_description` (cache an image description),
`get_brief`, `set_brief`.

All read-only over WhatsApp. **No `send_message` tool exists by design** — this MCP cannot send anything on your behalf, which significantly cuts down the prompt-injection blast radius.

---

## Configuration

Environment variables the bridge respects:

| Var | Default | Meaning |
|---|---|---|
| `WHATSAPP_BRIDGE_PORT` | `8765` | Local HTTP port the bridge listens on |
| `WHATSAPP_HISTORY_DAYS` | `30` | Drop history-sync messages older than this many days |
| `WHATSAPP_VOICE_MAX_SECONDS` | `300` | Skip voice notes longer than this when transcribing |
| `WHATSAPP_STALE_MS` | `180000` | Force reconnect if no socket activity in this long |
| `OPENAI_API_KEY` | (none) | Used by Whisper. Falls back to `api-key.txt` in repo root. |

---

## Troubleshooting

**Claude says "MCP whatsapp: server disconnected"**

Click `windows\restart-bridge.bat` to kill the old bridge and start a fresh one. The MCP server in Claude will reconnect on next tool call. If it persists, check `data\bridge.log`.

**My phone shows the device "last active" stuck at some old time, even though Claude says connected**

The WebSocket has gone zombie - TCP socket still open, but no real traffic. The bridge's keepalive + watchdog should auto-fix in ~3 minutes. If not, run `windows\restart-bridge.bat`.

**440 / "stream conflict" errors**

Another linked device (or a stale one) is claiming the slot. On your phone: WhatsApp -> Settings -> Linked Devices -> log out everything that isn't your current Mac OS / Cowork entry. Then ask Claude to "re-link my WhatsApp".

**`get_image` says "no media keys stored"**

The message was cached before this code added media-key tracking. Only images received **after** the bridge restart with media-key support can be downloaded. Tomorrow's images will work.

**`get_image` says "download failed"**

Most likely the image is more than ~14 days old and WhatsApp's CDN has garbage-collected the encrypted blob. The media key is still valid, but the bytes are gone.

**I want to nuke everything and start over**

`windows\reset.bat`. Confirms with "YES", stops bridge, wipes `auth\` and `data\`.

---

## Security & privacy

- **Everything stays local** by default. Cache lives in `data\store.json`. Auth lives in `auth\`.
- The bridge connects only to WhatsApp's own servers via the [Baileys](https://github.com/WhiskeySockets/Baileys) library (open source).
- When you ask Claude a question, only the specific messages relevant to that question are sent to Anthropic's servers as part of your normal Claude conversation.
- If you enable Whisper transcription, voice-note audio bytes are sent to OpenAI for transcription, then the transcript is cached locally. After that, the audio is not re-sent.
- **Don't share `auth/` or `api-key.txt`** - they're sensitive. `.gitignore` excludes them by default.
- **WhatsApp ToS gray area:** WhatsApp's official Terms of Service do not explicitly authorize third-party clients via Baileys-style multi-device automation. Read-only personal use has historically not been targeted, but there is no guarantee - use at your own risk.

---

## How a Claude assistant should set this up for the user

*(This section is written for Claude itself, in case the user pastes this README into a chat and asks Claude to install the project.)*

1. Confirm the user has Node 18+ installed (`node --version` via Bash/Terminal). If not, point them to https://nodejs.org/.
2. Have them clone this repo to a stable path (anywhere except temp folders).
3. Have them double-click `windows\install.bat` (or run the equivalent on macOS/Linux: `npm install` + `node scripts/install-mcp-config.mjs`).
4. Confirm `%APPDATA%\Claude\claude_desktop_config.json` now contains an `mcpServers.whatsapp` entry pointing at this project's `src/index.js`. If not, edit it manually.
5. Optionally, ask the user for an OpenAI API key for voice transcription. Tell them to paste it directly into `api-key.txt` in the repo root - do not ask them to share it in chat.
6. Tell them to quit and reopen Claude Desktop / Cowork.
7. Once back in chat, call the MCP tool `relink_whatsapp` to get a QR. Render the QR's `qr` data string visibly in chat (e.g. via a widget that uses `qrcode-generator` from a CDN). Ask them to scan from WhatsApp -> Settings -> Linked Devices -> Link a Device.
8. After the user scans, call `wait_for_link` to confirm.
9. Verify with `get_status` that `connected: true`.

You're done - from here, normal queries like "summarize my last 12 hours" will work.

---

## License

MIT - see `LICENSE`.

Built on [@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys) and the [Model Context Protocol SDK](https://github.com/modelcontextprotocol).
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    