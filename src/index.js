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
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `bridge HTTP ${res.status}: ${text.slice(0, 200)}` };
    }
    return await res.json();
  } catch (e) {
    return { ok: false, error: `bridge unreachable: ${e?.message || e}` };
  }
}

// ---------- MCP server ----------
const server = new McpServer({ name: "whatsapp-readonly", version: "0.3.0" });
const ok = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });

server.tool(
  "get_status",
  "Return current WhatsApp connection status (connected, retention, transcription, cache size, idle seconds, etc).",
  {},
  async () => ok(await callBridge("GET", "/status", null, 5000))
);

server.tool(
  "list_chats",
  "List WhatsApp chats from the local cache, sorted by most recent activity.",
  { excludeGroups: z.boolean().optional().default(false) },
  async (args) => ok(await callBridge("POST", "/list-chats", args, 15_000))
);

server.tool(
  "get_recent_messages",
  "Get messages from the last N hours from the local cache. Optionally filter to one chatId or exclude groups.",
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
  "Case-insensitive substring search across cached messages. Looks back `hours` hours (default 720 = 30 days).",
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

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  "[mcp] MCP server ready on stdio. Tools: get_status, list_chats, get_recent_messages, search_messages, get_brief, set_brief, relink_whatsapp, wait_for_link, force_resync, enrich_window."
);
