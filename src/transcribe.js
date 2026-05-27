// OpenAI Whisper API client for transcribing WhatsApp voice notes.
//
// Configuration:
//   - Set OPENAI_API_KEY env var (preferred), OR
//   - Drop the key into <project>/api-key.txt (single line, no quotes)
//
// Cost: ~$0.006 per minute of audio (whisper-1 model). A typical 30s voice
// note costs ~$0.003. Audio leaves your machine only to OpenAI's servers.
import fs from "node:fs";
import path from "node:path";

const MODEL = "whisper-1";

let cachedKey = null;
let cachedKeyAt = 0;

export function loadApiKey(projectRoot) {
  // Re-read at most every 30 seconds so the user can edit the file
  // without restarting Cowork.
  if (cachedKey && Date.now() - cachedKeyAt < 30_000) return cachedKey;

  const fromEnv = (process.env.OPENAI_API_KEY || "").trim();
  if (fromEnv) {
    cachedKey = fromEnv;
    cachedKeyAt = Date.now();
    return cachedKey;
  }

  if (projectRoot) {
    const file = path.join(projectRoot, "api-key.txt");
    if (fs.existsSync(file)) {
      try {
        const raw = fs.readFileSync(file, "utf8").trim();
        if (raw && !raw.startsWith("#")) {
          cachedKey = raw;
          cachedKeyAt = Date.now();
          return cachedKey;
        }
      } catch {}
    }
  }

  cachedKey = null;
  cachedKeyAt = Date.now();
  return null;
}

export async function transcribeAudio(buffer, { apiKey, mimeType = "audio/ogg", language } = {}) {
  if (!apiKey) return { ok: false, error: "no OPENAI_API_KEY configured" };
  if (!buffer || buffer.length === 0) return { ok: false, error: "empty audio" };

  // Whisper accepts ~25 MB max. WhatsApp voice notes are tiny (KB).
  // Choose a filename extension based on mime so the server picks the right codec.
  let ext = "ogg";
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) ext = "mp3";
  else if (mimeType.includes("wav")) ext = "wav";
  else if (mimeType.includes("m4a") || mimeType.includes("aac")) ext = "m4a";

  const form = new FormData();
  const blob = new Blob([buffer], { type: mimeType });
  form.append("file", blob, `audio.${ext}`);
  form.append("model", MODEL);
  if (language) form.append("language", language);

  try {
    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}` },
      body: form,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return { ok: false, error: `HTTP ${res.status}: ${txt.slice(0, 200)}` };
    }
    const json = await res.json();
    const text = (json && typeof json.text === "string") ? json.text.trim() : "";
    return { ok: true, text };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}
