// Baileys connection controller. Read-only — no send/edit/delete functions.
//
// Includes:
//   - aggressive WebSocket keep-alive (15s)
//   - a staleness watchdog: if no socket activity for 3 min, force-reconnect.
//     This catches "zombie" connections where the OS keeps the TCP socket
//     open but the network has gone dead (NAT idle timeout, wifi flap, etc.)
//   - auto-reconnect on all close codes except explicit loggedOut (401)
//   - voice-note transcription queue (OpenAI Whisper, configured via api-key.txt)
import fs from "node:fs";
import path from "node:path";
import {
  default as makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  downloadMediaMessage,
} from "@whiskeysockets/baileys";
import pino from "pino";
import { loadApiKey, transcribeAudio } from "./transcribe.js";

const logger = pino({ level: "silent" });

const HISTORY_DAYS = Number(process.env.WHATSAPP_HISTORY_DAYS) || 30;
const VOICE_TRANSCRIBE_MAX_SECONDS = Number(process.env.WHATSAPP_VOICE_MAX_SECONDS) || 300;
const TRANSCRIBE_PARALLEL = 2;

// Staleness watchdog. If no socket activity in this long, force a reconnect.
const STALE_THRESHOLD_MS = Number(process.env.WHATSAPP_STALE_MS) || 3 * 60 * 1000;
const WATCHDOG_CHECK_MS = 30 * 1000;
const KEEPALIVE_MS = 15 * 1000;

export async function createWhatsAppController({
  authDir = "auth",
  store,
  onQR,
  onReady,
  onClosed,
  onHistoryBatch,
}) {
  fs.mkdirSync(authDir, { recursive: true });

  let { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  let currentSock = null;
  let attempts = 0;
  let stopped = false;
  let latestQR = null;
  let latestQRAt = 0;
  let isConnected = false;
  let lastCloseCode = null;
  let lastError = null;
  let lastHistoryBatchAt = 0;
  let lastActivityAt = Date.now();
  let watchdogTimer = null;

  function bumpActivity() { lastActivityAt = Date.now(); }

  // Transcription queue (unchanged).
  const TRANSCRIBE_RECENT_HOURS = Number(process.env.WHATSAPP_TRANSCRIBE_HOURS) || 36;
  const transcribeQueue = [];
  let transcribeInFlight = 0;
  let transcribed = 0;
  let transcribeFailures = 0;
  const projectRoot = path.resolve(authDir, "..");

  function unwrapForMedia(m) {
    if (!m) return m;
    const wrappers = ["ephemeralMessage","viewOnceMessage","viewOnceMessageV2","viewOnceMessageV2Extension","documentWithCaptionMessage","editedMessage","futureProofMessage","deviceSentMessage"];
    for (const w of wrappers) if (m[w]?.message) return unwrapForMedia(m[w].message);
    return m;
  }

  function maybeQueueTranscribe(msg) {
    if (!msg?.message || !msg?.key?.id || !msg?.key?.remoteJid) return;
    const inner = unwrapForMedia(msg.message);
    const audio = inner?.audioMessage;
    if (!audio?.ptt) return;
    const ts = Number(msg.messageTimestamp) || 0;
    if (ts > 0 && ts < Math.floor(Date.now() / 1000) - TRANSCRIBE_RECENT_HOURS * 3600) return;
    transcribeQueue.push({
      msg,
      chatId: msg.key.remoteJid,
      msgId: msg.key.id,
      durationSec: Number(audio.seconds) || 0,
      mime: audio.mimetype || "audio/ogg",
    });
    processTranscribeQueue();
  }

  async function processTranscribeQueue() {
    if (transcribeInFlight >= TRANSCRIBE_PARALLEL) return;
    if (!transcribeQueue.length) return;
    const apiKey = loadApiKey(projectRoot);
    if (!apiKey) { transcribeQueue.length = 0; return; }
    transcribeInFlight++;
    const item = transcribeQueue.shift();
    try {
      if (item.durationSec && item.durationSec > VOICE_TRANSCRIBE_MAX_SECONDS) return;
      const buffer = await downloadMediaMessage(item.msg, "buffer", {}, { logger });
      if (!buffer || buffer.length === 0) return;
      const result = await transcribeAudio(buffer, { apiKey, mimeType: item.mime });
      if (result?.ok && result.text) {
        store.setTranscript(item.chatId, item.msgId, result.text);
        transcribed++;
      } else {
        transcribeFailures++;
      }
    } catch {
      transcribeFailures++;
    } finally {
      transcribeInFlight--;
      setImmediate(processTranscribeQueue);
    }
  }

  async function reloadAuthState() {
    const fresh = await useMultiFileAuthState(authDir);
    state = fresh.state;
    saveCreds = fresh.saveCreds;
  }

  function connect() {
    if (stopped) return null;
    attempts++;
    bumpActivity();

    const sock = makeWASocket({
      version,
      auth: state,
      logger,
      markOnlineOnConnect: false,
      syncFullHistory: true,
      shouldSyncHistoryMessage: () => true,
      browser: Browsers.macOS("Cowork"),
      emitOwnEvents: true,
      generateHighQualityLinkPreview: false,
      // Aggressive keepalive — fires WS ping every 15s. If WhatsApp's
      // server doesn't respond, Baileys closes the socket and our close
      // handler triggers reconnect.
      keepAliveIntervalMs: KEEPALIVE_MS,
      connectTimeoutMs: 30_000,
      defaultQueryTimeoutMs: 30_000,
    });

    currentSock = sock;
    sock.ev.on("creds.update", () => { bumpActivity(); saveCreds(); });

    sock.ev.on("connection.update", (update) => {
      bumpActivity();
      const { connection, lastDisconnect, qr } = update;
      if (qr && onQR) { latestQR = qr; latestQRAt = Date.now(); onQR(qr); }

      if (connection === "open") {
        attempts = 0;
        isConnected = true;
        latestQR = null;
        lastError = null;
        if (onReady) onReady(sock);
      }

      if (connection === "close") {
        isConnected = false;
        const code = lastDisconnect?.error?.output?.statusCode;
        lastCloseCode = code;
        lastError = lastDisconnect?.error || null;
        const loggedOut = code === DisconnectReason.loggedOut;
        if (onClosed) onClosed({ loggedOut, code });

        if (stopped) return;
        if (loggedOut) { stopped = true; return; }

        const delay = code === 515 ? 500 : Math.min(30_000, 1000 * attempts);
        setTimeout(() => { connect(); }, delay);
      }
    });

    sock.ev.on("chats.upsert", (chats) => { bumpActivity(); chats.forEach((c) => store.upsertChat(c)); });
    sock.ev.on("chats.update", (chats) => { bumpActivity(); chats.forEach((c) => store.upsertChat(c)); });
    sock.ev.on("contacts.upsert", (cs) => { bumpActivity(); cs.forEach((c) => store.upsertContact(c)); });
    sock.ev.on("contacts.update", (cs) => { bumpActivity(); cs.forEach((c) => store.upsertContact(c)); });

    sock.ev.on("messaging-history.set", (data) => {
      bumpActivity();
      const chats = data?.chats || [];
      const contacts = data?.contacts || [];
      const messages = data?.messages || [];
      const isLatest = !!data?.isLatest;
      const syncType = data?.syncType;
      for (const c of chats) store.upsertChat(c);
      for (const c of contacts) store.upsertContact(c);
      const cutoffSec = Math.floor(Date.now() / 1000) - HISTORY_DAYS * 86400;
      let kept = 0, dropped = 0;
      for (const m of messages) {
        const ts = Number(m?.messageTimestamp) || 0;
        if (ts > 0 && ts < cutoffSec) { dropped++; continue; }
        store.addMessage(m);
        // Voice/image enrichment is on-demand via /enrich-window — no
        // automatic Whisper/Vision calls on message arrival. Keeps OpenAI
        // bill at $0 unless the user actually asks for a brief.
        kept++;
      }
      lastHistoryBatchAt = Date.now();
      if (onHistoryBatch) onHistoryBatch({ chats: chats.length, contacts: contacts.length, messages: kept, droppedOld: dropped, isLatest, syncType });
    });

    sock.ev.on("messages.upsert", ({ messages }) => {
      bumpActivity();
      // On-demand only: no Whisper / Vision calls here. Just cache the text
      // + media keys. Enrichment happens later when /enrich-window is called.
      for (const m of messages) { store.addMessage(m); }
    });

    // Other low-level events that prove the socket is alive (presence,
    // group metadata, app-state-sync chunks, etc.) — just bump activity.
    sock.ev.on("messages.update", () => bumpActivity());
    sock.ev.on("message-receipt.update", () => bumpActivity());
    sock.ev.on("presence.update", () => bumpActivity());
    sock.ev.on("groups.update", () => bumpActivity());

    return sock;
  }

  function deleteAuthFiles() {
    if (!fs.existsSync(authDir)) return 0;
    let count = 0;
    for (const f of fs.readdirSync(authDir)) {
      try { fs.unlinkSync(path.join(authDir, f)); count++; } catch {}
    }
    return count;
  }

  async function tearDownSocket() {
    if (!currentSock) return;
    try { currentSock.ev.removeAllListeners(); } catch {}
    try { currentSock.end(undefined); } catch {}
    try { if (currentSock.ws && typeof currentSock.ws.close === "function") currentSock.ws.close(); } catch {}
    currentSock = null;
  }

  // Watchdog: if no socket activity for STALE_THRESHOLD_MS, force a reconnect.
  function startWatchdog() {
    if (watchdogTimer) return;
    watchdogTimer = setInterval(async () => {
      if (stopped) return;
      const idle = Date.now() - lastActivityAt;
      if (idle > STALE_THRESHOLD_MS && currentSock) {
        console.error(`[whatsapp] STALE: no activity for ${Math.round(idle/1000)}s — tearing down zombie socket and reconnecting`);
        isConnected = false;
        lastCloseCode = "stale";
        try { await tearDownSocket(); } catch {}
        attempts = 0;
        bumpActivity(); // reset clock so we don't immediately re-trip
        try { connect(); } catch (e) {
          console.error("[whatsapp] reconnect after stale failed:", e?.message || e);
        }
      }
    }, WATCHDOG_CHECK_MS);
    if (watchdogTimer.unref) watchdogTimer.unref();
  }

  async function relink({ waitMs = 25_000 } = {}) {
    stopped = true;
    await tearDownSocket();
    isConnected = false;
    latestQR = null;
    latestQRAt = 0;

    const deleted = deleteAuthFiles();
    await reloadAuthState();

    stopped = false;
    attempts = 0;
    bumpActivity();
    connect();

    const start = Date.now();
    while (Date.now() - start < waitMs) {
      if (latestQR) return { ok: true, qr: latestQR, deletedAuthFiles: deleted };
      if (isConnected) return { ok: true, qr: null, alreadyConnected: true, deletedAuthFiles: deleted };
      await new Promise((r) => setTimeout(r, 250));
    }
    return { ok: false, qr: null, error: "timeout waiting for QR" };
  }

  async function waitForLink({ waitMs = 60_000 } = {}) {
    const start = Date.now();
    while (Date.now() - start < waitMs) {
      if (isConnected) return { connected: true };
      await new Promise((r) => setTimeout(r, 500));
    }
    return { connected: false, timedOut: true };
  }

  async function forceResync() {
    if (!currentSock && stopped) {
      return { ok: false, error: "stopped (logged out) — call relink first" };
    }
    isConnected = false;
    await tearDownSocket();
    attempts = 0;
    stopped = false;
    bumpActivity();
    connect();
    return { ok: true, message: "reconnecting" };
  }

  function getStatus() {
    const apiKey = loadApiKey(projectRoot);
    const idleSec = Math.round((Date.now() - lastActivityAt) / 1000);
    // Heuristic: even if our flag says connected, treat as warning if no
    // activity has happened in over 90s. Watchdog will hard-fix at 3 min.
    const looksStale = isConnected && idleSec > 90;
    return {
      connected: isConnected,
      looksStale,
      idleSec,
      hasQR: !!latestQR,
      qrAgeSec: latestQR ? Math.round((Date.now() - latestQRAt) / 1000) : null,
      lastCloseCode,
      lastError: lastError?.message || null,
      lastHistoryBatchAt: lastHistoryBatchAt ? new Date(lastHistoryBatchAt).toISOString() : null,
      lastActivityAt: new Date(lastActivityAt).toISOString(),
      stopped,
      attempts,
      historyRetentionDays: HISTORY_DAYS,
      transcription: {
        enabled: !!apiKey,
        queueDepth: transcribeQueue.length,
        inFlight: transcribeInFlight,
        transcribed,
        failures: transcribeFailures,
      },
    };
  }

  function getCurrentQR() {
    return {
      qr: latestQR,
      qrAgeSec: latestQR ? Math.round((Date.now() - latestQRAt) / 1000) : null,
      connected: isConnected,
    };
  }

  connect();
  startWatchdog();

  return { relink, waitForLink, forceResync, getStatus, getCurrentQR };
}
