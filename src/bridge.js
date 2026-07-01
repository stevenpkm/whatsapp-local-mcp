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
import { classifyError, ok as okEnvelope, fail } from "./errors.js";
import { defaultFilename, resolveFolder, validateFilename, ensureFolder, extFor } from "./media-paths.js";
// Image analysis is done by Claude via the get_image MCP tool (using the Claude
// subscription), not by a separate OpenAI Vision call.

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

// Debounce manual reconnect/relink so a user clicking the dashboard button
// repeatedly can't hammer WhatsApp into a rate-limit / ban. Returns seconds to
// wait (0 = allowed, and records the attempt).
let lastManualReconnectAt = 0;
function reconnectCooldownSec() {
  const COOLDOWN = 15_000;
  const since = Date.now() - lastManualReconnectAt;
  if (since < COOLDOWN) return Math.ceil((COOLDOWN - since) / 1000);
  lastManualReconnectAt = Date.now();
  return 0;
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

// Save one media item to disk. Returns a structured envelope. Used by
// /save-image, /save-voice, /save-media, and the bulk endpoint.
async function saveMediaItem({ msg, expectedKind, folder, filename, opts = {} }) {
  if (!msg) return fail("not_found", "message not in cache");
  if (!msg.media) return fail("not_media", "message has no media payload", { type: msg.type });
  if (expectedKind && msg.media.kind !== expectedKind) {
    return fail(`not_${expectedKind}`, `kind=${msg.media.kind}`, { chatId: msg.chatId, msgId: msg.id });
  }
  if (!msg.media.mediaKey) return fail("no_keys", "this message was cached before media-key tracking was added", { chatId: msg.chatId, msgId: msg.id });

  // Resolve folder + filename. Folder defaults to data/media/<YYYY-MM-DD>/
  // based on the MESSAGE timestamp so files group by chat date, not save date.
  const epochMs = (Number(msg.timestamp) || Date.now());
  const folderRes = resolveFolder({ projectRoot, folder, epochMs });
  if (!folderRes.ok) return folderRes;
  const fnRes = validateFilename(filename);
  if (!fnRes.ok) return fnRes;

  // Skip-if-exists: if a file with the same intended name already exists,
  // and we're not overwriting, return early with the existing path.
  const chatName = store.nameFor(msg.chatId);
  const senderName = msg.fromMe ? "you" : store.nameFor(msg.sender);
  const finalFn = fnRes.filename || defaultFilename({
    epochMs, chatName, senderName, msgId: msg.id,
    mimeType: msg.media.mimetype, kind: msg.media.kind,
  });
  const targetPath = path.join(folderRes.folder, finalFn);

  if (opts.skipIfExists !== false && fs.existsSync(targetPath)) {
    let stat = null;
    try { stat = fs.statSync(targetPath); } catch {}
    return okEnvelope({
      path: targetPath,
      filename: finalFn,
      folder: folderRes.folder,
      kind: msg.media.kind,
      mimeType: msg.media.mimetype || null,
      sizeBytes: stat?.size ?? null,
      width: msg.media.width || null,
      height: msg.media.height || null,
      chatId: msg.chatId,
      msgId: msg.id,
      chat: chatName,
      sender: senderName,
      timestampISO: new Date(epochMs).toISOString(),
      skipped: true,
      reason: "file_already_exists",
    });
  }

  // Make sure the folder exists.
  const mkdir = ensureFolder(folderRes.folder);
  if (!mkdir.ok) return mkdir;

  // Per-item timeout (defaults: image 30s, voice 60s, video 120s).
  const defaultTimeout = msg.media.kind === "video" ? 120_000 : (msg.media.kind === "audio" ? 60_000 : 30_000);
  const timeoutMs = Number(opts.timeoutMs) || defaultTimeout;

  // Download via Baileys. Wrap in a timeout race so a stalled CDN doesn't
  // hold the slot forever.
  let buf;
  try {
    const downloadKind = msg.media.kind === "voice" ? "audio" : msg.media.kind;
    const stream = await downloadContentFromMessage(buildDownloadable(msg.media), downloadKind);
    buf = await Promise.race([
      streamToBuffer(stream),
      new Promise((_, rej) => setTimeout(() => rej(new Error("download timed out")), timeoutMs)),
    ]);
  } catch (e) {
    const { code, error } = classifyError(e, "download_failed");
    return fail(code, error, { chatId: msg.chatId, msgId: msg.id });
  }
  if (!buf || buf.length === 0) {
    return fail("download_failed", "empty buffer from CDN (likely expired)", { chatId: msg.chatId, msgId: msg.id });
  }

  // Write to disk.
  try {
    fs.writeFileSync(targetPath, buf);
    // Set mtime to the message's WhatsApp timestamp so Explorer sorts correctly.
    try { fs.utimesSync(targetPath, new Date(epochMs), new Date(epochMs)); } catch {}
  } catch (e) {
    const { code, error } = classifyError(e, "disk_error");
    return fail(code, error, { chatId: msg.chatId, msgId: msg.id, path: targetPath });
  }

  return okEnvelope({
    path: targetPath,
    filename: finalFn,
    folder: folderRes.folder,
    kind: msg.media.kind,
    mimeType: msg.media.mimetype || null,
    sizeBytes: buf.length,
    width: msg.media.width || null,
    height: msg.media.height || null,
    durationSec: msg.media.seconds || null,
    chatId: msg.chatId,
    msgId: msg.id,
    chat: chatName,
    sender: senderName,
    timestampISO: new Date(epochMs).toISOString(),
  });
}

// Heuristic: is a message's encrypted blob likely garbage-collected from the
// WhatsApp CDN? Anything older than ~13 days is at risk.
function defaultFilenameDir() {
  const d = new Date();
  const ymd = d.toISOString().slice(0, 10);
  return path.join(projectRoot, "data", "media", ymd);
}

function looksExpired(msg) {
  const ts = Number(msg?.media?.mediaKeyTimestamp) || (Number(msg?.timestamp) ? Math.floor(msg.timestamp / 1000) : 0);
  if (!ts) return false;
  const ageDays = (Date.now() / 1000 - ts) / 86400;
  return ageDays > 13;
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
      if (!body?.brief) return sendJson(res, 400, fail("invalid_argument", "missing brief"));
      try {
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(briefCacheFile, JSON.stringify(body.brief, null, 2));
        return sendJson(res, 200, okEnvelope());
      } catch (e) {
        const { code, error } = classifyError(e, "disk_error");
        return sendJson(res, 500, fail(code, error));
      }
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
      if (!body?.query) return sendJson(res, 400, fail("invalid_argument", "missing query"));
      return sendJson(res, 200, { status: statusBlock(), query: body.query, matches: store.searchMessages(body) });
    }
    if (route === "POST /relink") {
      if (!controller) return sendJson(res, 500, fail("bridge_unhealthy", "controller not initialized"));
      const cd = reconnectCooldownSec();
      if (cd) return sendJson(res, 429, { ok: false, error: `wait ${cd}s before reconnecting again - rapid reconnects can get WhatsApp to block the number`, retryAfterSec: cd });
      const body = await readJson(req);
      const result = await controller.relink({ waitMs: body?.waitMs || 25000 });
      return sendJson(res, 200, { ...result, status: statusBlock() });
    }
    if (route === "POST /wait-for-link") {
      if (!controller) return sendJson(res, 500, fail("bridge_unhealthy", "controller not initialized", { connected: false }));
      const body = await readJson(req);
      const result = await controller.waitForLink({ waitMs: body?.waitMs || 60000 });
      return sendJson(res, 200, { ...result, status: statusBlock() });
    }
    if (route === "POST /force-resync") {
      if (!controller) return sendJson(res, 500, fail("bridge_unhealthy", "controller not initialized"));
      const cd = reconnectCooldownSec();
      if (cd) return sendJson(res, 429, { ok: false, error: `wait ${cd}s before reconnecting again - rapid reconnects can get WhatsApp to block the number`, retryAfterSec: cd });
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
        return sendJson(res, 400, fail("invalid_argument", "missing chatId or msgId"));
      }
      const msg = store.messages.find((m) => m.chatId === body.chatId && m.id === body.msgId);
      if (!msg) return sendJson(res, 404, fail("not_found", "message not in cache", { chatId: body.chatId, msgId: body.msgId }));
      if (!msg.media) return sendJson(res, 400, fail("not_media", "message has no media payload", { type: msg.type }));
      if (msg.media.kind !== "image") return sendJson(res, 400, fail("not_image", `kind=${msg.media.kind}`));
      if (!msg.media.mediaKey) return sendJson(res, 400, fail("no_keys", "this message was cached before media-key tracking was added"));
      try {
        const stream = await downloadContentFromMessage(buildDownloadable(msg.media), "image");
        const buf = await streamToBuffer(stream);
        return sendJson(res, 200, okEnvelope({
          data: buf.toString("base64"),
          mimeType: msg.media.mimetype || "image/jpeg",
          width: msg.media.width,
          height: msg.media.height,
          sizeBytes: buf.length,
        }));
      } catch (e) {
        const { code, error } = classifyError(e, "download_failed");
        return sendJson(res, code === "media_expired" ? 410 : 500, fail(code, error, { chatId: body.chatId, msgId: body.msgId }));
      }
    }
    if (route === "POST /set-description") {
      const body = await readJson(req);
      if (!body?.chatId || !body?.msgId || !body?.description) {
        return sendJson(res, 400, fail("invalid_argument", "missing chatId, msgId, or description"));
      }
      const didSet = store.setDescription(body.chatId, body.msgId, String(body.description));
      if (didSet) return sendJson(res, 200, okEnvelope());
      return sendJson(res, 404, fail("not_found", "message not in cache", { chatId: body.chatId, msgId: body.msgId }));
    }
    if (route === "POST /save-image") {
      const body = await readJson(req);
      if (!body?.chatId || !body?.msgId) return sendJson(res, 400, fail("invalid_argument", "missing chatId or msgId"));
      const msg = store.messages.find((m) => m.chatId === body.chatId && m.id === body.msgId);
      const result = await saveMediaItem({ msg, expectedKind: "image", folder: body.folder, filename: body.filename, opts: { skipIfExists: body.skipIfExists !== false, timeoutMs: body.timeoutMs } });
      return sendJson(res, result.ok ? 200 : (result.code === "media_expired" ? 410 : (result.code === "not_found" ? 404 : 500)), result);
    }
    if (route === "POST /save-voice") {
      const body = await readJson(req);
      if (!body?.chatId || !body?.msgId) return sendJson(res, 400, fail("invalid_argument", "missing chatId or msgId"));
      const msg = store.messages.find((m) => m.chatId === body.chatId && m.id === body.msgId);
      // Voice notes in our store are kind=audio. Accept both kind="voice" and "audio".
      const expected = (msg?.media?.kind === "voice") ? "voice" : "audio";
      const result = await saveMediaItem({ msg, expectedKind: expected, folder: body.folder, filename: body.filename, opts: { skipIfExists: body.skipIfExists !== false, timeoutMs: body.timeoutMs } });
      // Optional: also transcribe on the fly if requested and no cached transcript.
      if (result.ok && body.transcribe === true) {
        const cachedTranscript = msg?.transcript || null;
        if (cachedTranscript) {
          result.transcript = cachedTranscript;
          result.transcribed = false;
        } else {
          const apiKey = loadApiKey(projectRoot);
          if (!apiKey) {
            result.transcript = null;
            result.transcribed = false;
            result.transcribeError = fail("no_api_key", "no OpenAI API key in api-key.txt");
          } else {
            try {
              const tBuf = fs.readFileSync(result.path);
              const tResult = await transcribeAudio(tBuf, { apiKey, mimeType: msg.media.mimetype || "audio/ogg" });
              if (tResult?.ok && tResult.text) {
                store.setTranscript(msg.chatId, msg.id, tResult.text);
                result.transcript = tResult.text;
                result.transcribed = true;
              } else {
                result.transcribed = false;
                result.transcribeError = fail("transcribe_failed", tResult?.error || "unknown");
              }
            } catch (e) {
              result.transcribed = false;
              result.transcribeError = fail("transcribe_failed", e?.message || String(e));
            }
          }
        }
      }
      return sendJson(res, result.ok ? 200 : (result.code === "media_expired" ? 410 : (result.code === "not_found" ? 404 : 500)), result);
    }
    if (route === "POST /save-media") {
      const body = await readJson(req);
      if (!body?.chatId || !body?.msgId) return sendJson(res, 400, fail("invalid_argument", "missing chatId or msgId"));
      const msg = store.messages.find((m) => m.chatId === body.chatId && m.id === body.msgId);
      // Generic primitive: no expectedKind filter. Infers from msg.media.kind.
      const result = await saveMediaItem({ msg, expectedKind: null, folder: body.folder, filename: body.filename, opts: { skipIfExists: body.skipIfExists !== false, timeoutMs: body.timeoutMs } });
      return sendJson(res, result.ok ? 200 : (result.code === "media_expired" ? 410 : (result.code === "not_found" ? 404 : 500)), result);
    }
    if (route === "POST /list-media-window") {
      const body = await readJson(req);
      const hours = Math.max(1, Math.min(720, Number(body?.hours) || 24));
      const kinds = Array.isArray(body?.kinds) && body.kinds.length ? body.kinds.map(String) : ["image", "voice"];
      const wantsAudio = kinds.includes("voice") || kinds.includes("audio");
      const kindsResolved = new Set(kinds.flatMap(k => k === "voice" ? ["voice","audio"] : [k]));
      const limit = Math.max(1, Math.min(2000, Number(body?.limit) || 200));
      const excludeGroups = !!body?.excludeGroups;
      const chatId = body?.chatId || null;
      const cutoff = Date.now() - hours * 3600 * 1000;

      const items = [];
      for (let i = store.messages.length - 1; i >= 0; i--) {
        if (items.length >= limit) break;
        const m = store.messages[i];
        if (!m?.media) continue;
        if (chatId && m.chatId !== chatId) continue;
        if (excludeGroups && m.isGroup) continue;
        if (!kindsResolved.has(m.media.kind)) continue;
        if ((m.timestamp || 0) < cutoff) break;
        items.push({
          chatId: m.chatId,
          msgId: m.id,
          kind: m.media.kind,
          mimeType: m.media.mimetype || null,
          sender: m.fromMe ? "you" : store.nameFor(m.sender),
          chat: store.nameFor(m.chatId),
          isGroup: !!m.isGroup,
          timestampISO: new Date(m.timestamp || 0).toISOString(),
          sizeBytes: m.media.fileLength || null,
          width: m.media.width || null,
          height: m.media.height || null,
          durationSec: m.media.seconds || null,
          hasMediaKey: !!m.media.mediaKey,
          likelyExpired: looksExpired(m),
        });
      }
      // Roll up by kind for quick summarization
      const byKind = {};
      for (const it of items) byKind[it.kind] = (byKind[it.kind] || 0) + 1;
      return sendJson(res, 200, okEnvelope({ hours, kinds, items, totalCount: items.length, byKind }));
    }
    if (route === "POST /save-media-window") {
      const body = await readJson(req);
      const hours = Math.max(1, Math.min(720, Number(body?.hours) || 24));
      const kinds = Array.isArray(body?.kinds) && body.kinds.length ? body.kinds.map(String) : ["image"];
      const kindsResolved = new Set(kinds.flatMap(k => k === "voice" ? ["voice","audio"] : [k]));
      const maxItems = Math.max(1, Math.min(500, Number(body?.maxItems) || 100));
      const concurrency = Math.max(1, Math.min(8, Number(body?.concurrency) || 3));
      const excludeGroups = !!body?.excludeGroups;
      const chatId = body?.chatId || null;
      const folder = body?.folder || undefined;
      const transcribe = body?.transcribe === true;
      const skipIfExists = body?.skipIfExists !== false;
      const startedAt = Date.now();
      const cutoff = startedAt - hours * 3600 * 1000;

      // Collect candidates (newest first), capped at maxItems.
      const candidates = [];
      for (let i = store.messages.length - 1; i >= 0; i--) {
        if (candidates.length >= maxItems) break;
        const m = store.messages[i];
        if (!m?.media) continue;
        if (chatId && m.chatId !== chatId) continue;
        if (excludeGroups && m.isGroup) continue;
        if (!kindsResolved.has(m.media.kind)) continue;
        if ((m.timestamp || 0) < cutoff) break;
        candidates.push(m);
      }

      // Pre-flight: bridge / WhatsApp must be connected.
      const st = controller?.getStatus?.();
      if (!st?.connected) {
        return sendJson(res, 503, fail("not_connected", "WhatsApp socket not connected; cannot download media", { candidateCount: candidates.length }));
      }

      // Run downloads concurrently, but stop issuing new ones if we lose
      // connection or hit ENOSPC.
      let stoppedReason = null;
      const items = await runWithConcurrency(candidates, concurrency, async (msg) => {
        if (stoppedReason) {
          return fail(stoppedReason, `aborted before processing`, { chatId: msg.chatId, msgId: msg.id });
        }
        const r = await saveMediaItem({
          msg,
          expectedKind: null,
          folder,
          filename: undefined,
          opts: { skipIfExists, timeoutMs: body?.timeoutMs },
        });
        if (r.ok && transcribe && msg.media.kind === "audio") {
          // Best-effort post-save transcription. Reuse cached if present.
          if (msg.transcript) {
            r.transcript = msg.transcript;
            r.transcribed = false;
          } else {
            const apiKey = loadApiKey(projectRoot);
            if (apiKey) {
              try {
                const buf = fs.readFileSync(r.path);
                const tr = await transcribeAudio(buf, { apiKey, mimeType: msg.media.mimetype || "audio/ogg" });
                if (tr?.ok && tr.text) {
                  store.setTranscript(msg.chatId, msg.id, tr.text);
                  r.transcript = tr.text;
                  r.transcribed = true;
                } else {
                  r.transcribed = false;
                  r.transcribeError = tr?.error || "unknown";
                }
              } catch (e) {
                r.transcribed = false;
                r.transcribeError = e?.message || String(e);
              }
            }
          }
        }
        if (!r.ok) {
          if (r.code === "disk_full") stoppedReason = "disk_full";
          if (r.code === "disconnected" || r.code === "not_connected") stoppedReason = "disconnected";
        }
        return r;
      });

      // Aggregate
      const saved = items.filter(i => i.ok).length;
      const failed = items.length - saved;
      const errors = {};
      for (const i of items) {
        if (!i.ok) errors[i.code] = (errors[i.code] || 0) + 1;
      }
      const errorsArr = Object.entries(errors).map(([code, count]) => ({ code, count }));

      // Determine the folder where files landed (resolve once). Fall back to
      // today's folder (not the window-start date) when nothing was saved.
      const folderUsed = items.find(i => i.ok)?.folder
        || resolveFolder({ projectRoot, folder, epochMs: Date.now() }).folder
        || null;

      return sendJson(res, 200, okEnvelope({
        hours,
        kinds,
        folder: folderUsed,
        candidates: candidates.length,
        saved,
        failed,
        truncatedAt: candidates.length >= maxItems ? "max_items_reached" : (stoppedReason || null),
        errors: errorsArr,
        items,
        durationMs: Date.now() - startedAt,
      }));
    }
        if (route === "GET /where") {
      // where_do_media_files_go: inspect the default folder.
      const today = defaultFilenameDir();
      let exists = false, fileCount = 0, sizeBytes = 0;
      try {
        const stat = fs.statSync(today);
        exists = stat.isDirectory();
        if (exists) {
          const files = fs.readdirSync(today);
          fileCount = files.length;
          for (const f of files) {
            try { sizeBytes += fs.statSync(path.join(today, f)).size; } catch {}
          }
        }
      } catch {}
      return sendJson(res, 200, okEnvelope({
        defaultFolder: today,
        defaultFolderForToday: today,
        exists,
        fileCount,
        sizeBytes,
        projectRoot,
      }));
    }
    if (route === "POST /backfill-history") {
      if (!controller) return sendJson(res, 503, fail("bridge_unhealthy", "controller not initialized"));
      const st = controller.getStatus?.();
      if (!st?.connected) return sendJson(res, 503, fail("not_connected", "WhatsApp not connected; cannot fetch history"));
      const body = await readJson(req);
      const count = Math.max(1, Math.min(500, Number(body?.count) || 50));
      const topK = Math.max(1, Math.min(100, Number(body?.chats) || 10));
      const settleMs = Math.max(0, Math.min(60_000, Number(body?.settleMs ?? 20_000)));
      const onlyChatId = body?.chatId || null;

      // Anchor per chat = the NEWEST cached message in that chat. fetchMessageHistory
      // pulls `count` messages OLDER than the anchor, which is what covers a recent gap.
      const newestByChat = new Map();
      for (const m of store.messages) {
        if (!m?.chatId || !m?.id) continue;
        if (onlyChatId && m.chatId !== onlyChatId) continue;
        const prev = newestByChat.get(m.chatId);
        if (!prev || (m.timestamp || 0) > (prev.timestamp || 0)) newestByChat.set(m.chatId, m);
      }
      let anchors = [...newestByChat.values()].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      if (!onlyChatId) anchors = anchors.slice(0, topK);

      const cacheBefore = store.messages.length;
      const requested = [];
      for (const m of anchors) {
        const key = { remoteJid: m.chatId, fromMe: !!m.fromMe, id: m.id };
        const r = await controller.fetchHistory(count, key, Number(m.timestamp) || Date.now());
        requested.push({
          chat: store.nameFor(m.chatId),
          chatId: m.chatId,
          anchorMsgId: m.id,
          anchorTimeISO: new Date(Number(m.timestamp) || 0).toISOString(),
          count,
          ok: !!r?.ok,
          requestId: r?.ok ? r.requestId : undefined,
          error: r?.ok ? undefined : r?.error,
        });
      }

      // On-demand history arrives asynchronously via messaging-history.set.
      // Wait a bit, then report how many messages actually landed.
      if (settleMs) await new Promise((r) => setTimeout(r, settleMs));
      const cacheAfter = store.messages.length;

      return sendJson(res, 200, okEnvelope({
        requestedChats: requested.length,
        count,
        settleMs,
        cacheBefore,
        cacheAfter,
        messagesAdded: cacheAfter - cacheBefore,
        requested,
        note: "On-demand history arrives asynchronously; messagesAdded reflects only what landed within settleMs - more may keep arriving after. HOW FAR BACK WhatsApp serves is decided by WhatsApp; this call is the way to find out for this account. Re-run get_recent_messages to inspect the filled-in history.",
      }));
    }
    if (route === "GET /healthz") return sendJson(res, 200, { ok: true, pid: process.pid });

    // Live QR page - open in browser, auto-refreshes, shows "Connected" when linked.
    if (route === "GET /qr.json") {
      if (!controller) return sendJson(res, 200, { qr: null, connected: false, error: "controller not initialized" });
      return sendJson(res, 200, controller.getCurrentQR());
    }
    if (route === "GET /qr") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(QR_PAGE_HTML);
    }
    if (route === "GET /" || route === "GET /dashboard") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(DASHBOARD_HTML);
    }

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
  console.error(`[bridge] Live QR page: http://127.0.0.1:${PORT}/qr`);
});

// ---------- live QR page (served at /qr) ----------
const QR_PAGE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>WhatsApp QR</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root{color-scheme:light}
  body{display:flex;align-items:center;justify-content:center;min-height:100vh;background:#fafafa;margin:0;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#1a1a1a}
  .card{background:#fff;padding:36px 40px;border-radius:14px;box-shadow:0 2px 24px rgba(0,0,0,.06);text-align:center;max-width:440px}
  h1{font-size:22px;margin:0 0 4px;font-weight:600}
  .sub{color:#888;font-size:13px;margin:0 0 24px}
  #qr{width:300px;height:300px;margin:0 auto;display:flex;align-items:center;justify-content:center}
  #qr svg{width:100%;height:100%}
  .hint{font-size:13px;color:#555;margin-top:24px;line-height:1.6}
  .age{font-size:11px;color:#aaa;margin-top:10px;min-height:14px}
  .connected{color:#15803d;font-size:24px;font-weight:600;padding:60px 0}
  .pending{color:#888;font-size:14px;padding:80px 20px;line-height:1.5}
</style></head>
<body><div class="card">
  <h1>WhatsApp QR</h1>
  <div class="sub" id="sub">Scan this with your phone</div>
  <div id="qr"><div class="pending">Loading…</div></div>
  <div class="hint" id="hint">On your phone: WhatsApp → Settings → Linked Devices → Link a Device → scan</div>
  <div class="age" id="age"></div>
</div>
<script src="https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js"></script>
<script>
  let currentQR = null;
  let done = false;
  async function poll() {
    if (done) return;
    try {
      const r = await fetch('/qr.json', { cache: 'no-store' });
      const j = await r.json();
      if (j.connected) {
        done = true;
        document.getElementById('sub').textContent = 'Linked successfully';
        document.getElementById('qr').innerHTML = '<div class="connected">\u2713 Connected!</div>';
        document.getElementById('hint').textContent = 'You can close this tab and go back to Cowork.';
        document.getElementById('age').textContent = '';
        return;
      }
      if (j.qr) {
        if (j.qr !== currentQR) {
          currentQR = j.qr;
          const q = qrcode(0, 'M');
          q.addData(j.qr);
          q.make();
          document.getElementById('qr').innerHTML = q.createSvgTag(8, 0);
        }
        document.getElementById('age').textContent = 'QR refreshed ' + (j.qrAgeSec || 0) + 's ago - auto-refreshes when it expires';
      } else {
        document.getElementById('qr').innerHTML = '<div class="pending">No QR yet. In Cowork, type:<br><br><b>scan my WhatsApp</b><br><br>then come back to this tab.</div>';
        document.getElementById('age').textContent = '';
      }
    } catch (e) { /* ignore transient errors */ }
    setTimeout(poll, 2500);
  }
  poll();
</script>
</body></html>`;


// ---------- status / refresh / diagnose dashboard (served at / ) ----------
const DASHBOARD_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>WhatsApp connection</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root{color-scheme:light}
  body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#fafafa;color:#1a1a1a;margin:0;display:flex;justify-content:center;padding:32px 16px}
  .card{background:#fff;max-width:460px;width:100%;border-radius:14px;box-shadow:0 2px 24px rgba(0,0,0,.06);padding:26px 26px 22px}
  h1{font-size:19px;margin:0 0 2px}
  .sub{color:#999;font-size:12px;margin:0 0 20px}
  .badge{display:flex;align-items:center;gap:9px;font-weight:600;font-size:15px;padding:11px 14px;border-radius:10px}
  .dot{width:10px;height:10px;border-radius:50%;flex:none}
  .ok{background:#f0fdf4;color:#15803d} .ok .dot{background:#16a34a}
  .warn{background:#fffbeb;color:#b45309} .warn .dot{background:#d97706}
  .bad{background:#fef2f2;color:#b91c1c} .bad .dot{background:#dc2626}
  .muted{background:#f3f4f6;color:#6b7280} .muted .dot{background:#9ca3af}
  .meta{font-size:13px;color:#555;margin:13px 2px 18px;line-height:1.6}
  .btns{display:flex;gap:10px}
  button{flex:1;font:inherit;font-weight:600;font-size:14px;padding:11px 12px;border-radius:10px;border:1px solid #e5e7eb;background:#fff;color:#1a1a1a;cursor:pointer}
  button.primary{background:#111;color:#fff;border-color:#111}
  button:disabled{opacity:.45;cursor:not-allowed}
  .note{font-size:11.5px;color:#b45309;margin:10px 2px 0;min-height:14px}
  #qrwrap{display:none;margin-top:18px;text-align:center}
  #qr{width:256px;height:256px;margin:0 auto;display:flex;align-items:center;justify-content:center}
  #qr svg{width:100%;height:100%}
  .hint{font-size:12px;color:#777;margin-top:12px;line-height:1.6}
  details{margin-top:18px;font-size:12px;color:#666}
  pre{background:#f6f8fa;padding:10px;border-radius:8px;overflow:auto;font-size:11px;line-height:1.4}
</style></head>
<body><div class="card">
  <h1>WhatsApp connection</h1>
  <div class="sub">Runs 100% on this computer</div>
  <div id="badge" class="badge muted"><span class="dot"></span><span id="btext">Checking...</span></div>
  <div class="meta" id="meta"></div>
  <div class="btns">
    <button id="reconnect" onclick="act('/force-resync','reconnect')">Reconnect</button>
    <button id="relink" class="primary" onclick="startRelink()">Re-link (new QR)</button>
  </div>
  <div class="note" id="note"></div>
  <div id="qrwrap">
    <div id="qr"><div>Loading QR...</div></div>
    <div class="hint">Phone: WhatsApp &rarr; Settings &rarr; Linked Devices &rarr; Link a Device &rarr; scan this. Auto-refreshes; shows Connected when done.</div>
  </div>
  <details><summary>Details (diagnosis)</summary><pre id="details">...</pre></details>
</div>
<script src="https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js"></script>
<script>
  var relinkMode=false, curQR=null;
  function $id(x){return document.getElementById(x);}
  var CLS={connected:'ok',stale:'warn',reconnecting:'warn',waiting_for_scan:'warn',needs_relink:'bad',gave_up:'bad'};
  var TXT={connected:'Connected',stale:'Connected (syncing)',reconnecting:'Reconnecting...',waiting_for_scan:'Waiting for QR scan',needs_relink:'Needs re-scan',gave_up:'Stopped - click Reconnect'};
  function fmt(s){if(s<60)return s+'s';if(s<3600)return Math.round(s/60)+'m';return Math.round(s/3600)+'h';}
  function startRelink(){relinkMode=true;$id('qrwrap').style.display='block';act('/relink','relink');}
  function act(path,btn){
    var b=$id(btn); b.disabled=true;
    fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})
      .then(function(r){return r.json().then(function(j){return {s:r.status,j:j};});})
      .then(function(o){
        if(o.s===429&&o.j&&o.j.retryAfterSec){$id('note').textContent='Please wait '+o.j.retryAfterSec+'s - clicking too fast can get WhatsApp to block your number.';}
        else{$id('note').textContent='';}
      }).catch(function(){});
    setTimeout(function(){b.disabled=false;},15000);
  }
  function poll(){
    fetch('/status',{cache:'no-store'}).then(function(r){return r.json();}).then(function(s){
      var h=s.health||(s.connected?'connected':'reconnecting');
      $id('badge').className='badge '+(CLS[h]||'muted');
      $id('btext').textContent=TXT[h]||h;
      var c=s.cache||{};
      var m=(c.messages||0).toLocaleString()+' messages, '+(c.chats||0).toLocaleString()+' chats cached';
      if(!s.connected&&s.downForSec)m+=' - offline '+fmt(s.downForSec);
      if(s.connected&&s.idleSec!=null)m+=' - last activity '+s.idleSec+'s ago';
      $id('meta').textContent=m;
      $id('details').textContent=JSON.stringify({health:h,connected:s.connected,lastCloseCode:s.lastCloseCode,attempts:s.attempts,needsRelink:s.needsRelink,gaveUp:s.gaveUp,transcription:s.transcription},null,2);
      if(relinkMode||h==='waiting_for_scan'){
        fetch('/qr.json',{cache:'no-store'}).then(function(r){return r.json();}).then(function(q){
          if(q.connected){relinkMode=false;$id('qrwrap').style.display='none';}
          else if(q.qr&&q.qr!==curQR){curQR=q.qr;$id('qrwrap').style.display='block';var g=qrcode(0,'M');g.addData(q.qr);g.make();$id('qr').innerHTML=g.createSvgTag(6,0);}
        }).catch(function(){});
      } else if(s.connected){$id('qrwrap').style.display='none';}
    }).catch(function(){}).then(function(){setTimeout(poll,3000);});
  }
  poll();
</script>
</body></html>`;
