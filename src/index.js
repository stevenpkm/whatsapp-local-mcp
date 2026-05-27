#!/usr/bin/env node
// WhatsApp MCP server — thin HTTP client for the long-running bridge.
//
// Architecture (Plan B):
//   Cowork → spawns this MCP server (per session)
//   This MCP server → talks to bridge.js over HTTP
//   bridge.js → always running (detached), holds Baileys connection
//
// On first launch each day (or after reboot), this MCP server spawns the
// bridge as a detached child, then connects to it. Subsequent launches of
// Cowork find the bridge already running via PID lock and just reuse it.
// Result: Cowork crashes and restarts don't break the WhatsApp connection.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { classifyError } from "./errors.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const dataDir = path.join(projectRoot, "data");
const pidFile = path.join(dataDir, "bridge.pid");
const bridgePath = path.join(here, "bridge.js");
const PORT = Number(process.env.WHATSAPP_BRIDGE_PORT) || 8765;
const BRIDGE_URL = `http://127.0.0.1:${PORT}`;

process.on("uncaughtException", (e) =>
  console.error("[mcp] uncaughtException:", e?.stack || e?.message || e)
);
process.on("unhandledRejection", (r) =>
  console.error("[mcp] unhandledRejection:", r?.stack || r?.message || r)
);

// ---------- bridge management ----------
async function bridgeIsAlive(timeoutMs = 1500) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`${BRIDGE_URL}/healthz`, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

async function spawnBridge() {
  console.error(`[mcp] starting bridge: ${process.execPath} ${bridgePath}`);
  const child = spawn(process.execPath, [bridgePath], {
    detached: true,
    stdio: "ignore",
    cwd: projectRoot,
    env: { ...process.env },
  });
  child.unref();
  child.on("error", (e) => console.error("[mcp] failed to spawn bridge:", e.message));
  bridgeSpawnAt = Date.now();
}

async function ensureBridge() {
  if (await bridgeIsAlive()) {
    console.error("[mcp] bridge already running");
    return true;
  }
  await spawnBridge();
  // Poll for the bridge to come up. Total wait up to ~20s.
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await bridgeIsAlive()) {
      console.error("[mcp] bridge is up");
      return true;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.error("[mcp] WARNING: bridge did not come up in 20s. Tools may fail until it does.");
  return false;
}

await ensureBridge();

// ---------- HTTP client helpers ----------
// Track the most recent successful contact with the bridge so we can
// distinguish "bridge is restarting" from "bridge is gone."
let bridgeLastSeenAt = 0;
let bridgeSpawnAt = 0;

async function callBridge(method, route, body, timeoutMs = 90_000) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`${BRIDGE_URL}${route}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    clearTimeout(t);
    bridgeLastSeenAt = Date.now();
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      try {
        const j = JSON.parse(text);
        if (j && typeof j === "object" && j.ok === false) return j;
      } catch {}
      // Non-JSON or non-envelope body: classify by status.
      if (res.status === 503) {
        return { ok: false, code: "bridge_restarting", retriable: true, suggestedRetryMs: 3000, error: `bridge HTTP 503: ${text || "(empty)"}` };
      }
      return { ok: false, code: "download_failed", error: `bridge HTTP ${res.status}: ${text || "(empty)"}` };
    }
    return await res.json();
  } catch (e) {
    const { code, error } = classifyError(e, "bridge_unreachable");
    // Refine: if we successfully called the bridge in the last 30s but now
    // can't, it's probably restarting (e.g. user ran restart-bridge.bat).
    if (code === "bridge_unreachable") {
      const sinceSeen = Date.now() - bridgeLastSeenAt;
      const sinceSpawn = Date.now() - bridgeSpawnAt;
      if (sinceSeen > 0 && sinceSeen < 30_000) {
        return { ok: false, code: "bridge_restarting", retriable: true, suggestedRetryMs: 3000, error: "bridge was reachable a moment ago; it's likely restarting. Wait a few seconds and try again." };
      }
      if (sinceSpawn > 0 && sinceSpawn < 30_000) {
        return { ok: false, code: "bridge_restarting", retriable: true, suggestedRetryMs: 3000, error: "bridge spawned recently and is still booting. Wait a few seconds and try again." };
      }
      // Attempt to spawn it. If we can, return bridge_restarting; otherwise
      // bridge_unreachable.
      try {
        await spawnBridge();
        bridgeSpawnAt = Date.now();
        return { ok: false, code: "bridge_restarting", retriable: true, suggestedRetryMs: 5000, error: "bridge was down; I just spawned it. Wait ~5 seconds and try again." };
      } catch (spawnErr) {
        return { ok: false, code: "bridge_unreachable", retriable: true, error: `bridge process not running and could not be spawned: ${spawnErr?.message || spawnErr}` };
      }
    }
    return { ok: false, code, error: `bridge call failed: ${error}`, retriable: code === "timeout" };
  }
}

// ---------- MCP server ----------
const server = new McpServer({ name: "whatsapp-readonly", version: "0.3.0" });
// Wrap a bridge result into an MCP tool response. Sets isError: true when
// the bridge returned ok:false so spec-compliant clients can branch.
// If the result includes a `path` field (i.e. a saved file), emit an extra
// `resource_link` content block per MCP spec — that lets capable clients
// surface the file as a clickable artifact.
function asToolResult(obj) {
  const isError = obj && obj.ok === false;
  const blocks = [{ type: "text", text: JSON.stringify(obj, null, 2) }];
  if (!isError && obj && typeof obj.path === "string" && obj.path.length > 0) {
    // file:/// URI per spec. Normalize Windows backslashes.
    const fileUri = "file:///" + obj.path.replace(/\\/g, "/").replace(/^\//, "");
    blocks.unshift({
      type: "resource_link",
      uri: fileUri,
      name: obj.filename || obj.path.split(/[\\/]/).pop(),
      mimeType: obj.mimeType || undefined,
      description: obj.chat ? `From ${obj.chat}` : undefined,
    });
  }
  return {
    content: blocks,
    ...(isError ? { isError: true } : {}),
  };
}
const ok = asToolResult;

server.tool(
  "get_status",
  "Return current WhatsApp connection status (connected, retention, transcription, cache size, idle seconds, etc).",
  {},
  async () => ok(await callBridge("GET", "/status", null, 5000))
);

server.tool(
  "list_chats",
  "List WhatsApp chats from the local cache, sorted by most recent activity. Each chat has both `name` (human-friendly, e.g. \"XPENG MALAYSIA OWNER CLUB\" or \"Steve\") and `id` (raw WhatsApp JID like \"1234@g.us\"). ALWAYS refer to chats by `name` when talking to the user — the `id` is only for follow-up tool calls and should never be shown to the user.",
  { excludeGroups: z.boolean().optional().default(false) },
  async (args) => ok(await callBridge("POST", "/list-chats", args, 15_000))
);

server.tool(
  "get_recent_messages",
  "Get messages from the last N hours from the local cache. Optionally filter to one chatId or exclude groups. Each message includes `chat` (the chat's human-friendly name) and `from` (sender's name). NEVER show the raw chatId, msgId, or sender JID to the user — always speak in names. The IDs are only for follow-up tool calls (e.g. get_image needs chatId+msgId).",
  {
    hours: z.number().min(1).max(720).default(24),
    excludeGroups: z.boolean().optional().default(false),
    chatId: z.string().optional(),
    limit: z.number().min(1).max(2000).optional().default(500),
  },
  async (args) => ok(await callBridge("POST", "/get-recent-messages", args, 30_000))
);

server.tool(
  "search_messages",
  "Case-insensitive substring search across cached messages. Looks back `hours` hours (default 720 = 30 days). Returns `chat` and `from` as human-friendly names. NEVER show raw chat IDs or message IDs to the user.",
  {
    query: z.string().min(1),
    hours: z.number().min(1).max(2160).optional().default(720),
    excludeGroups: z.boolean().optional().default(false),
    limit: z.number().min(1).max(500).optional().default(100),
  },
  async (args) => ok(await callBridge("POST", "/search-messages", args, 30_000))
);

server.tool(
  "get_brief",
  "Return the most recently generated brief from data/brief.json, or null if none exists.",
  {},
  async () => ok(await callBridge("GET", "/brief", null, 5000))
);

server.tool(
  "set_brief",
  "Write a JSON brief object to data/brief.json. Called by Claude after analyzing messages, so the WhatsApp Brief artifact can render it.",
  {
    brief: z.object({
      generatedAt: z.string().optional(),
      params: z.any().optional(),
      model: z.string().optional(),
      messageCount: z.number().optional(),
      tasks: z.array(z.any()).optional(),
      waiting: z.array(z.any()).optional(),
      remember: z.array(z.any()).optional(),
    }).passthrough(),
  },
  async (args) => ok(await callBridge("POST", "/set-brief", args, 5000))
);

server.tool(
  "relink_whatsapp",
  "Delete stale credentials and start a fresh QR pair. Returns the raw QR data string in `qr`; render it as a scannable QR image and ask the user to scan it from their phone (WhatsApp → Settings → Linked Devices → Link a Device). Cache is preserved.",
  { waitMs: z.number().min(5000).max(60000).optional().default(25000) },
  async (args) => ok(await callBridge("POST", "/relink", args, 30_000))
);

server.tool(
  "wait_for_link",
  "Block until WhatsApp connection.open fires or timeout. Use after relink_whatsapp to confirm the user scanned successfully.",
  { waitMs: z.number().min(1000).max(120000).optional().default(60000) },
  async (args) => ok(await callBridge("POST", "/wait-for-link", args, 130_000))
);

server.tool(
  "force_resync",
  "Reconnect the WhatsApp socket. Use only when chats look stale; normally the bridge keeps itself connected.",
  {},
  async () => ok(await callBridge("POST", "/force-resync", null, 15_000))
);


server.tool(
  "get_image",
  "Download a specific cached image from WhatsApp and return its bytes inline as image content so Claude can see and describe it natively (Opus vision is sharper than gpt-4o-mini). Pass the msgId and chatId from a get_recent_messages result that has hasMedia=true and type=imageMessage. Fails gracefully if media keys are missing (message cached before key tracking was added) or expired (>~14 days old).",
  {
    chatId: z.string(),
    msgId: z.string(),
  },
  async ({ chatId, msgId }) => {
    const r = await callBridge("POST", "/get-image", { chatId, msgId }, 30000);
    if (!r?.ok) {
      return ok({ ok: false, error: r?.error || "download failed", chatId, msgId });
    }
    return {
      content: [
        { type: "image", data: r.data, mimeType: r.mimeType || "image/jpeg" },
        { type: "text", text: JSON.stringify({ ok: true, mimeType: r.mimeType, width: r.width, height: r.height, sizeBytes: r.sizeBytes, chatId, msgId }) },
      ],
    };
  }
);

server.tool(
  "set_description",
  "After viewing an image via get_image, save your description back to the cache. Future briefs reuse it without re-asking Claude (so each image only costs vision tokens once). Pass chatId + msgId + description (1-2 sentences ideally).",
  {
    chatId: z.string(),
    msgId: z.string(),
    description: z.string().min(1),
  },
  async (args) => ok(await callBridge("POST", "/set-description", args, 5000))
);

server.tool(
  "enrich_window",
  "VOICE-ONLY enrichment for the last N hours. Downloads voice notes and transcribes them via OpenAI Whisper. Idempotent (skips already-transcribed). IMPORTANT: this tool no longer touches images — image analysis is done by Claude (you) via the get_image tool, using the Cowork subscription instead of OpenAI Vision. To produce a full brief with both voice transcripts and image descriptions: (1) call enrich_window for voice, (2) call get_image one-by-one for each image in the window and call set_description to cache your description, (3) then call get_recent_messages to read the enriched text and write the brief.",
  {
    hours: z.number().min(1).max(168).optional().default(12),
    concurrency: z.number().min(1).max(8).optional().default(3),
    maxItems: z.number().min(1).max(500).optional().default(100),
  },
  async (args) => ok(await callBridge("POST", "/enrich-window", args, 300000))
);

server.tool(
  "save_image",
  "Save a single WhatsApp image to disk. Pass the chatId + msgId from a get_recent_messages result. Default folder: <project>/data/media/<YYYY-MM-DD>/, named <timestamp>__<chat>__<sender>__<msgId-tail>.jpg. Returns the absolute path as a resource_link. On failure returns {ok:false, code, error} where code is one of: not_found, not_image, no_keys, media_expired, download_failed, disk_error, permission_denied, disk_full, timeout. The MCP response sets isError:true on failure.",
  {
    chatId: z.string(),
    msgId: z.string(),
    folder: z.string().optional().describe("Absolute path where the file should land. Defaults to <project>/data/media/<date>/."),
    filename: z.string().optional().describe("Override the filename. Path separators not allowed."),
    skipIfExists: z.boolean().optional().default(true).describe("If a file with the same name already exists, return its path without re-downloading."),
    timeoutMs: z.number().min(1000).max(180000).optional().describe("Per-download timeout. Default 30s for images."),
  },
  async (args) => ok(await callBridge("POST", "/save-image", args, 60_000))
);

server.tool(
  "save_voice",
  "Save a single voice note (.ogg) to disk. Same parameter contract as save_image. Optionally pass transcribe:true to also run Whisper transcription on the saved file (requires OpenAI API key in api-key.txt). Returns transcript inline when transcribed successfully. Same error-code set as save_image, plus: transcribe_failed, no_api_key.",
  {
    chatId: z.string(),
    msgId: z.string(),
    folder: z.string().optional(),
    filename: z.string().optional(),
    skipIfExists: z.boolean().optional().default(true),
    timeoutMs: z.number().min(1000).max(300000).optional().describe("Per-download timeout. Default 60s for voice."),
    transcribe: z.boolean().optional().default(false).describe("If true and no cached transcript exists, transcribe via Whisper after saving."),
  },
  async (args) => ok(await callBridge("POST", "/save-voice", args, 180_000))
);

server.tool(
  "save_media",
  "Generic save-to-disk for any media kind (image / audio / video / document). Use save_image or save_voice when you know the type — they're clearer to read. Use this when you have a mixed list of msgIds and don't want to branch.",
  {
    chatId: z.string(),
    msgId: z.string(),
    folder: z.string().optional(),
    filename: z.string().optional(),
    skipIfExists: z.boolean().optional().default(true),
    timeoutMs: z.number().min(1000).max(300000).optional(),
  },
  async (args) => ok(await callBridge("POST", "/save-media", args, 180_000))
);

server.tool(
  "list_media_window",
  "Preview which media items would be saved by save_media_window. Read-only — does NOT download or write anything. Returns per-item entries with chatId, msgId, kind, sender, chat, timestampISO, sizeBytes, mimeType, and `likelyExpired` (true when the media-key is older than ~13 days and the CDN may have garbage-collected the blob). Use this BEFORE save_media_window so you can tell the user 'I would save 14 images and 6 voice notes, but 3 are likely expired — proceed?'",
  {
    hours: z.number().min(1).max(720).optional().default(24),
    kinds: z.array(z.enum(["image", "voice", "audio", "video", "document"])).optional().default(["image","voice"]).describe("Which media types to include."),
    chatId: z.string().optional().describe("Limit to one chat. Optional."),
    excludeGroups: z.boolean().optional().default(false),
    limit: z.number().min(1).max(2000).optional().default(200),
  },
  async (args) => ok(await callBridge("POST", "/list-media-window", args, 15_000))
);

server.tool(
  "save_media_window",
  "Bulk-save WhatsApp media from the last N hours to disk. Downloads with bounded concurrency (default 3) and returns PER-ITEM results — items that fail (expired, no keys, network) are reported in `items[].ok=false` with a code, but the overall call still succeeds with `ok:true`. The `errors` array rolls up failure codes ({code, count}) for quick summarization. Default folder: <project>/data/media/<YYYY-MM-DD>/. Each item in the result has the absolute saved path. The call ABORTS the remaining work only on disk_full or disconnected — never on individual download failures.",
  {
    hours: z.number().min(1).max(720).optional().default(24),
    kinds: z.array(z.enum(["image","voice","audio","video","document"])).optional().default(["image"]).describe("Which media types to save."),
    chatId: z.string().optional(),
    excludeGroups: z.boolean().optional().default(false),
    folder: z.string().optional().describe("Override default folder. Must be an absolute path."),
    maxItems: z.number().min(1).max(500).optional().default(100),
    concurrency: z.number().min(1).max(8).optional().default(3),
    skipIfExists: z.boolean().optional().default(true).describe("If a target file already exists, skip the download and return the existing path."),
    transcribe: z.boolean().optional().default(false).describe("For voice notes: also run Whisper transcription. Requires api-key.txt."),
    timeoutMs: z.number().min(1000).max(300000).optional().describe("Per-item download timeout. Defaults: 30s images, 60s voice, 120s video."),
  },
  async (args) => ok(await callBridge("POST", "/save-media-window", args, 300_000))
);

server.tool(
  "where_do_media_files_go",
  "Return the default folder save_image / save_voice / save_media_window write to (today's folder under <project>/data/media/YYYY-MM-DD), plus how many files are already in it. Useful for answering 'where did you save them?' without filesystem access.",
  {},
  async () => ok(await callBridge("GET", "/where", null, 5000))
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  "[mcp] MCP server ready on stdio. Tools: get_status, list_chats, get_recent_messages, search_messages, get_brief, set_brief, relink_whatsapp, wait_for_link, force_resync, enrich_window, get_image, set_description, save_image, save_voice, save_media, list_media_window, save_media_window, where_do_media_files_go."
);
