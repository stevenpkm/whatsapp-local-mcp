#!/usr/bin/env node
// Always-on WhatsApp bridge. Survives Cowork restarts.
//
// MCP server (index.js) spawns this as a detached child on first launch.
// PID lock prevents duplicates. HTTP API on 127.0.0.1:8765.
//
// Endpoints:
//   GET  /healthz             liveness ping
//   GET  /status              connection + cache state
//   GET  /brief               read data/brief.json
//   POST /set-brief           write data/brief.json
//   POST /list-chats          read tool
//   POST /get-recent-messages read tool
//   POST /search-messages     read tool
//   POST /relink              delete auth, return fresh QR
//   POST /wait-for-link       block until open or timeout
//   POST /force-resync        soft reconnect
//   POST /enrich-window       download media + transcribe/describe via OpenAI

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { downloadContentFromMessage } from "@whiskeysockets/baileys";
import { Store } from "./store.js";
import { createWhatsAppController } from "./whatsapp.js";
import { transcribeAudio, loadApiKey } from "./transcribe.js";
// Note: we used to import describeImage from ./vision.js to enrich images
// via OpenAI gpt-4o-mini Vision. That's now disabled — image analysis is
// done by Claude (via the get_image MCP tool, using the Cowork subscription
// instead of a separate OpenAI bill). vision.js is kept around but unused.

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const authDir = path.join(projectRoot, "auth");
const dataDir = path.join(projectRoot, "data");
const briefCacheFile = path.join(dataDir, "brief.json");
const pidFile = path.join(dataDir, "bridge.pid");
const PORT = Number(process.env.WHATSAPP_BRIDGE_PORT) || 8765;

// ---------- crash guards ----------
process.on("uncaughtException", (e) =>
  console.error("[bridge] uncaughtException:", e?.stack || e?.message || e)
);
process.on("unhandledRejection", (r) =>
  console.error("[bridge] unhandledRejection:", r?.stack || r?.message || r)
);

// ---------- PID lock ----------
function isPidAlive(pid) {
  if (!pid || pid === process.pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function acquireLock() {
  fs.mkdirSync(dataDir, { recursive: true });
  if (fs.existsSync(pidFile)) {
    const existing = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
    if (isPidAlive(existing)) {
      console.error(`[bridge] another bridge already running (pid ${existing}); exiting`);
      process.exit(0);
    } else {
      console.error(`[bridge] stale PID file (pid ${existing} is dead); removing`);
      try { fs.unlinkSync(pidFile); } catch {}
    }
  }
  fs.writeFileSync(pidFile, String(process.pid));
}
function releaseLock() {
  try {
    if (!fs.existsSync(pidFile)) return;
    const pid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
    if (pid === process.pid) fs.unlinkSync(pidFile);
  } catch {}
}
process.on("exit", releaseLock);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => { releaseLock(); process.exit(0); });
}

acquireLock();

// ---------- boot ----------
const store = new Store(dataDir);
console.error(
  `[bridge] starting (pid ${process.pid}). cache: ${store.messages.length} messages, ${store.chats.size} chats.`
);

let controller = null;
let bootError = null;
try {
  controller = await createWhatsAppController({
    authDir, store,
    onQR: () => console.error("[bridge] WhatsApp wants a QR scan; call /relink"),
    onReady: () => console.error("[bridge] WhatsApp connected"),
    onClosed: ({ loggedOut, code }) => {
      if (loggedOut) console.error("[bridge] WhatsApp logged us out; call /relink");
      else console.error(`[bridge] connection closed (code=${code}); reconnecting...`);
    },
    onHistoryBatch: ({ chats, contacts, messages, droppedOld, isLatest }) => {
      const drop = droppedOld ? ` (skipped ${droppedOld} older)` : "";
      console.error(`[bridge] history batch: +${chats}c +${contacts}p +${messages}m${drop}${isLatest ? " [FINAL]" : ""}`);
    },
  });
} catch (e) {
  bootError = e?.message || String(e);
  console.error("[bridge] Baileys boot failed:", bootError);
}

// ---------- HTTP helpers ----------
async function readJson(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => { try { resolve(JSON.parse(body || "{}")); } catch { resolve({}); } });
  });
}
function sendJson(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

function statusBlock() {
  const cache = { messages: store.messages.length, chats: store.chats.size, contacts: store.contacts.size };
  if (!controller) return { bootError, cache, connected: false };
  return { ...controller.getStatus(), cache, bootError };
}

// ---------- enrich-window: download media + transcribe / describe ----------
async function streamToBuffer(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
}
function buildDownloadable(media) {
  const toBuf = (b64) => (b64 ? Buffer.from(b64, "base64") : undefined);
  return {
    url: media.url,
    directPath: media.directPath,
    mediaKey: toBuf(media.mediaKey),
    fileSha256: toBuf(media.fileSha256),
    fileEncSha256: toBuf(media.fileEncSha256),
    fileLength: media.fileLength,
    mediaKeyTimestamp: media.mediaKeyTimestamp,
  };
}
async function enrichOne(msg) {
  const media = msg.media;
  if (!media || !media.mediaKey) return { ok: false, reason: "no-keys" };
  let buffer;
  try {
    const stream = await downloadContentFromMessage(buildDownloadable(media), media.kind);
    buffer = await streamToBuffer(stream);
  } catch (e) {
    return { ok: false, reason: "download-failed", error: e?.message || String(e) };
  }
  if (!buffer || buffer.length === 0) return { ok: false, reason: "empty-buffer" };

  if (media.kind === "audio") {
    const apiKey = loadApiKey(projectRoot);
    if (!apiKey) return { ok: false, reason: "no-api-key" };
    const result = await transcribeAudio(buffer, { apiKey, mimeType: media.mimetype || "audio/ogg" });
    if (result?.ok && result.text) {
      store.setTranscript(msg.chatId, msg.id, result.text);
      return { ok: true, kind: "audio", chars: result.text.length };
    }
    return { ok: false, reason: "transcribe-failed", error: result?.error };
  }
  if (media.kind === "image") {
    // Images are NOT auto-described by OpenAI anymore. Claude (in the
    // Cowork chat) handles image vision on demand via the get_image MCP
    // tool. enrichWindow just leaves the image alone.
    return { ok: false, reason: "image-needs-claude-via-get_image" };
  }
  return { ok: false, reason: `kind-not-supported:${media.kind}` };
}
async function runWithConcurrency(items, limit, worker) {
  const results = [];
  let i = 0;
  async function next() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await worker(items[idx]);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => next());
  await Promise.all(workers);
  return results;
}
async function enrichWindow({ hours = 12, kinds = ["audio"], concurrency = 3, maxItems = 100 } = {}) {
  // Default = audio only. Images are routed through Claude via get_image
  // instead of OpenAI Vision, so they're skipped here even if requested.
  if (!Array.isArray(kinds) || kinds.length === 0) kinds = ["audio"];
  const candidates = store.listUnenrichedMedia({ hours, kinds });
  const toProcess = candidates.slice(0, maxItems);
  if (toProcess.length === 0) {
    return { ok: true, hours, candidates: 0, processed: 0, failed: 0, note: "nothing to enrich in this window" };
  }
  const startedAt = Date.now();
  const results = await runWithConcurrency(toProcess, concurrency, enrichOne);
  let okCount = 0, failCount = 0;
  const errors = [];
  for (let i = 0; i < results.length; i++) {
    if (results[i]?.ok) okCount++;
    else {
      failCount++;
      if (errors.length < 5) errors.push({ msgId: toProcess[i].id, reason: results[i]?.reason, error: results[i]?.error });
    }
  }
  return {
    ok: true,
    hours,
    candidates: candidates.length,
    processed: okCount,
    failed: failCount,
    durationMs: Date.now() - startedAt,
    truncatedAt: candidates.length > maxItems ? maxItems : null,
    errors,
  };
}

// ---------- HTTP server ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const route = `${req.method} ${url.pathname}`;

    if (route === "GET /status") return sendJson(res, 200, statusBlock());
    if (route === "GET /brief") {
      if (fs.existsSync(briefCacheFile)) {
        try { return sendJson(res, 200, { ok: true, brief: JSON.parse(fs.readFileSync(briefCacheFile, "utf8")) }); }
        catch (e) { return sendJson(res, 200, { ok: false, brief: null, error: e.message }); }
      }
      return sendJson(res, 200, { ok: true, brief: null });
    }
    if (route === "POST /set-brief") {
      const body = await readJson(req);
      if (!body?.brief) return sendJson(res, 400, { ok: false, error: "missing brief" });
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(briefCacheFile, JSON.stringify(body.brief, null, 2));
      return sendJson(res, 200, { ok: true });
    }
    if (route === "POST /list-chats") {
      const body = await readJson(req);
      return sendJson(res, 200, { status: statusBlock(), chats: store.listChats(body || {}) });
    }
    if (route === "POST /get-recent-messages") {
      const body = await readJson(req);
      return sendJson(res, 200, {
        status: statusBlock(),
        queriedHours: body?.hours ?? 24,
        messages: store.getRecentMessages(body || {}),
      });
    }
    if (route === "POST /search-messages") {
      const body = await readJson(req);
      if (!body?.query) return sendJson(res, 400, { ok: false, error: "missing query" });
      return sendJson(res, 200, { status: statusBlock(), query: body.query, matches: store.searchMessages(body) });
    }
    if (route === "POST /relink") {
      if (!controller) return sendJson(res, 500, { ok: false, error: "controller not initialized" });
      const body = await readJson(req);
      const result = await controller.relink({ waitMs: body?.waitMs || 25000 });
      return sendJson(res, 200, { ...result, status: statusBlock() });
    }
    if (route === "POST /wait-for-link") {
      if (!controller) return sendJson(res, 500, { ok: false, connected: false, error: "controller not initialized" });
      const body = await readJson(req);
      const result = await controller.waitForLink({ waitMs: body?.waitMs || 60000 });
      return sendJson(res, 200, { ...result, status: statusBlock() });
    }
    if (route === "POST /force-resync") {
      if (!controller) return sendJson(res, 500, { ok: false, error: "controller not initialized" });
      const result = await controller.forceResync();
      return sendJson(res, 200, { ...result, status: statusBlock() });
    }
    if (route === "POST /enrich-window") {
      const body = await readJson(req);
      const result = await enrichWindow(body || {});
      return sendJson(res, 200, result);
    }
    if (route === "POST /get-image") {
      const body = await readJson(req);
      if (!body?.chatId || !body?.msgId) {
        return sendJson(res, 400, { ok: false, error: "missing chatId or msgId" });
      }
      const msg = store.messages.find((m) => m.chatId === body.chatId && m.id === body.msgId);
      if (!msg) return sendJson(res, 404, { ok: false, error: "message not in cache" });
      if (!msg.media || msg.media.kind !== "image") {
        return sendJson(res, 400, { ok: false, error: `message is not an image (kind=${msg.media?.kind || "none"})` });
      }
      if (!msg.media.mediaKey) {
        return sendJson(res, 400, { ok: false, error: "no media keys stored for this message — it was cached before media-key tracking was added" });
      }
      try {
        const stream = await downloadContentFromMessage(buildDownloadable(msg.media), "image");
        const buf = await streamToBuffer(stream);
        return sendJson(res, 200, {
          ok: true,
          data: buf.toString("base64"),
          mimeType: msg.media.mimetype || "image/jpeg",
          width: msg.media.width,
          height: msg.media.height,
          sizeBytes: buf.length,
        });
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: `download failed: ${e?.message || e} (media may have expired on WhatsApp's CDN — keys last ~14 days)` });
      }
    }
    if (route === "POST /set-description") {
      const body = await readJson(req);
      if (!body?.chatId || !body?.msgId || !body?.description) {
        return sendJson(res, 400, { ok: false, error: "missing chatId, msgId, or description" });
      }
      const ok = store.setDescription(body.chatId, body.msgId, String(body.description));
      return sendJson(res, ok ? 200 : 404, { ok });
    }
    if (route === "GET /healthz") return sendJson(res, 200, { ok: true, pid: process.pid });

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  } catch (e) {
    console.error("[bridge] handler error:", e?.stack || e);
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: e?.message || String(e) }));
  }
});

server.on("error", (e) => {
  if (e?.code === "EADDRINUSE") {
    console.error(`[bridge] port ${PORT} already in use; another bridge running. Exiting.`);
    releaseLock();
    process.exit(1);
  } else {
    console.error("[bridge] server error:", e);
  }
});
server.listen(PORT, "127.0.0.1", () => {
  console.error(`[bridge] HTTP API listening on http://127.0.0.1:${PORT}`);
});
