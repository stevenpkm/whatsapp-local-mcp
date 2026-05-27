// Shared error-code vocabulary for every tool in this MCP.
// Spec: every tool that fails returns { ok: false, code, error, ...context }
// and the MCP layer (index.js) sets isError: true on the result. See the
// improvement plan (MCP-improvement-plan.md §5.1) for the rationale.

export const ERROR_CODES = Object.freeze({
  // Transport / process state
  bridge_unreachable: "bridge process is not running",
  bridge_restarting: "bridge is starting up; try again shortly",
  bridge_unhealthy: "bridge is alive but not responding",
  not_connected: "WhatsApp socket is not connected",
  disconnected: "WhatsApp disconnected mid-operation",
  timeout: "operation timed out",

  // Lookup
  not_found: "message or chat not found in cache",
  not_image: "message is not an image",
  not_voice: "message is not a voice note",
  not_media: "message has no media payload",

  // Media-key state
  no_keys: "message was cached before media-key tracking; cannot decrypt",
  media_expired: "WhatsApp CDN no longer holds this media (older than ~14 days)",
  download_failed: "download from WhatsApp CDN failed",

  // Disk
  disk_error: "filesystem error while writing",
  permission_denied: "no permission to write to the requested path",
  disk_full: "no space left on disk",
  invalid_filename: "filename contains characters that cannot be written on this OS",
  invalid_argument: "argument is missing or has the wrong type",

  // Transcription
  transcribe_failed: "Whisper transcription returned an error",
  no_api_key: "no OpenAI API key configured for transcription",
});

// Map a Node-style errno or thrown error to a code from the closed set above.
// Returns { code, error } where `error` is the original message (full, no truncation).
export function classifyError(e, fallbackCode = "download_failed") {
  const msg = e?.message || String(e || "");
  const code = e?.code;

  // Filesystem errnos
  if (code === "EACCES" || code === "EPERM") return { code: "permission_denied", error: msg };
  if (code === "ENOSPC") return { code: "disk_full", error: msg };
  if (code === "ENAMETOOLONG") return { code: "invalid_filename", error: msg };

  // Network / abort
  if (e?.name === "AbortError" || /aborted/i.test(msg)) return { code: "timeout", error: msg };
  if (/fetch failed|ECONNREFUSED|ECONNRESET|EHOSTUNREACH/.test(msg)) {
    return { code: "bridge_unreachable", error: msg };
  }

  // Baileys media expiry surfaces as HTTP 410/404 strings
  if (/410|cdn.*gone|no.*media|expired/i.test(msg)) return { code: "media_expired", error: msg };

  return { code: fallbackCode, error: msg };
}

// Standard success envelope helper. Use this in bridge handlers so every
// response carries `ok: true` at the top level.
export function ok(data = {}) {
  return { ok: true, ...data };
}

// Standard failure envelope. `code` must be a key of ERROR_CODES, otherwise
// it gets remapped to a generic code (no silent string leakage).
export function fail(code, error, context = {}) {
  if (!ERROR_CODES[code]) {
    // Fall back to a generic code rather than letting an unknown one through.
    return { ok: false, code: "download_failed", error: `[unknown-code:${code}] ${error}`, ...context };
  }
  return { ok: false, code, error: String(error || ERROR_CODES[code]), ...context };
}
