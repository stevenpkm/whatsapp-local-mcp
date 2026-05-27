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

## Quick install (non-technical users on Cowork)

If you're using **Cowork** (Claude's desktop app for non-developers) and you don't want to touch any files yourself, just copy the block below and paste it into a fresh Cowork chat. Cowork will do everything — clone, install, patch the config, and render the QR. The only things *you* need to do are: approve folder access, approve computer-use access, restart Cowork when told, and scan the QR on your phone.

````
Hi Claude. Please install the WhatsApp MCP from GitHub for me. I'm NOT technical. Do EVERYTHING yourself with your own tools — File Explorer, .bat double-clicking, folder navigation are all your job, not mine.

The only things I should have to do are:
1. Approve your folder-access request when you ask
2. Approve your computer-use access request
3. Fully quit and reopen Cowork when you tell me to
4. Scan a QR code with my phone at the very end

That's it.

Repo: https://github.com/stevenpkm/whatsapp-local-mcp

### Step 1: Check Node.js
Use computer-use to open PowerShell on my machine (Win+R → type "powershell" → Enter). Run `node --version` and screenshot the output.
- If version is 18+, continue.
- If "command not found" or version <18, STOP and tell me to install Node.js 18+ from https://nodejs.org/ first.

### Step 2: Get a folder on my real disk
Call mcp__cowork__request_cowork_directory and ask me to pick a folder where the project will live (Desktop or Documents). Without this, anything you create disappears into your sandbox. Wait for my approval.

### Step 3: Clone the repo
In bash, cd into the mounted folder and run:
  git clone https://github.com/stevenpkm/whatsapp-local-mcp.git

### Step 4: Install dependencies — WARN ME FIRST
Before running, say: "Installing dependencies — this downloads ~80MB and takes 2 to 5 minutes with no progress bar. It is NOT stuck. Don't close anything."

Then cd into whatsapp-local-mcp and run `npm install`. Wait for it to finish. Do not interrupt. Do not say it might be stuck.

### Step 5: Patch the Claude Desktop config
File path: C:\Users\<me>\AppData\Roaming\Claude\claude_desktop_config.json

Try in this order:
1. Read tool on that path — if it works, read and merge.
2. If Read fails, open it via PowerShell + computer-use:
     notepad "$env:APPDATA\Claude\claude_desktop_config.json"
3. If the file doesn't exist, create it.

Merge in (do NOT overwrite existing mcpServers):
{
  "mcpServers": {
    "whatsapp": {
      "command": "node",
      "args": ["FULL_ABSOLUTE_PATH/whatsapp-local-mcp/src/index.js"]
    }
  }
}

If your Write can't reach %APPDATA%, write a PowerShell merge script to my desktop and run it via computer-use. End state must be: config contains the whatsapp entry alongside any existing entries.

### Step 6: Tell me to restart
"Please fully quit Cowork — right-click the tray icon, choose Quit (not just close the window). Then reopen and tell me you're back."

### Step 7: Render the QR
When I'm back, call mcp__whatsapp__relink_whatsapp. Render the qr string as a scannable QR image inside a widget (use qrcode-generator from a CDN). Tell me: "On your phone, WhatsApp → Settings → Linked Devices → Link a Device → scan."

### Step 8: Verify
After scan, call mcp__whatsapp__wait_for_link, then mcp__whatsapp__get_status. Confirm connected: true. Say: "Done. Try asking: summarize my WhatsApp from the last 12 hours."

### Rules
- Do NOT tell me to double-click files. Launch them yourself via computer-use.
- Do NOT tell me to open Explorer or navigate folders.
- Do NOT stop mid-flow waiting for "click to continue."
- Do NOT say "this might be stuck" during npm install. Set expectations in Step 4 and let it run.
- If something fails, state clearly what failed and what you'll try next.

Begin with Step 1 now.
````

That's it. If you're not on Cowork, or you'd rather install it yourself, follow the manual steps below.

---

## Install

### Windows

1. **Clone the repo** somewhere stable (not Downloads):

   ```
   git clone https://github.com/YOUR-USERNAME/whatsapp-mcp.git
   cd whatsapp-mcp
   ```

2. **Double-click `windows\install.bat`**

   It will:
   - Run `npm install`
   - Write a `whatsapp` entry into your Claude Desktop config at `%APPDATA%\Claude\claude_desktop_config.json` so Claude knows to launch the MCP server.

3. *(Optional)* If you want voice-note transcription, create a file called `api-key.txt` in the repo root and paste your OpenAI key inside (one line, no quotes).

4. **Open Claude Desktop / Cowork.**

5. In chat, tell Claude: **"scan my WhatsApp"**

   Claude will call the `relink_whatsapp` tool, which renders a QR code in chat. Open WhatsApp on your phone, go to **Settings -> Linked Devices -> Link a Device**, scan it.

6. Done. The bridge stays alive in the background from now on.

### macOS / Linux

The `windows/*.bat` helpers are Windows-only, but the Node code is cross-platform. Install manually:

```bash
git clone https://github.com/YOUR-USERNAME/whatsapp-mcp.git
cd whatsapp-mcp
npm install
node scripts/install-mcp-config.mjs   # patches Claude Desktop config
```

On macOS, the Claude Desktop config path is `~/Library/Application Support/Claude/claude_desktop_config.json`. The install script targets `APPDATA` (Windows) by default. On macOS, edit that config manually if needed:

```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "node",
      "args": ["/absolute/path/to/whatsapp-mcp/src/index.js"]
    }
  }
}
```

For the bridge to survive across sessions on macOS/Linux, run `node src/bridge.js` in a launchctl/systemd unit (the Windows .bat handles spawning automatically).

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
