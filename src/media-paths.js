// Filename + folder helpers for saving media to disk.
// See improvement plan §4.5 for the convention:
//   <YYYY-MM-DDTHH-mm-ss>__<chat-slug>__<sender-slug>__<msgId-suffix>.<ext>

import fs from "node:fs";
import path from "node:path";

const MIME_TO_EXT = {
  "image/jpeg": "jpg",
  "image/jpg":  "jpg",
  "image/png":  "png",
  "image/gif":  "gif",
  "image/webp": "webp",
  "image/heic": "heic",
  "audio/ogg":  "ogg",
  "audio/opus": "ogg",
  "audio/mp4":  "m4a",
  "audio/mpeg": "mp3",
  "audio/aac":  "aac",
  "audio/wav":  "wav",
  "video/mp4":  "mp4",
  "video/3gpp": "3gp",
  "video/webm": "webm",
  "application/pdf": "pdf",
  "application/zip": "zip",
};

const KIND_DEFAULT_EXT = {
  image: "jpg",
  audio: "ogg",
  voice: "ogg",
  video: "mp4",
  document: "bin",
  sticker: "webp",
};

export function extFor(mimeType, kind) {
  if (mimeType && MIME_TO_EXT[mimeType.toLowerCase()]) return MIME_TO_EXT[mimeType.toLowerCase()];
  // mimeType like "image/jpeg;codecs=..."
  if (mimeType) {
    const base = mimeType.split(";")[0].trim().toLowerCase();
    if (MIME_TO_EXT[base]) return MIME_TO_EXT[base];
    const slash = base.indexOf("/");
    if (slash > 0) {
      const after = base.slice(slash + 1).replace(/[^a-z0-9]/g, "");
      if (after && after.length <= 5) return after;
    }
  }
  return KIND_DEFAULT_EXT[kind] || "bin";
}

// Slugify: lowercase, non-alphanumeric → "-", collapse repeats, trim.
// Maxes out at maxLen chars. Returns "unknown" if input slugs to empty.
export function slug(s, maxLen = 40) {
  if (s == null) return "unknown";
  const str = String(s)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining marks (so emoji-rich names don't explode)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
    .slice(0, maxLen)
    .replace(/-+$/, "");
  return str || "unknown";
}

// ISO timestamp, Windows-safe (`:` → `-`).
export function tsForFilename(epochMs) {
  const d = new Date(epochMs || Date.now());
  const iso = d.toISOString().replace(/\..+$/, ""); // strip ms + Z
  return iso.replace(/:/g, "-");
}

// Build a default folder under <projectRoot>/data/media/<YYYY-MM-DD>/.
// projectRoot is passed by the caller because we're a pure helper module.
export function defaultMediaFolder(projectRoot, epochMs) {
  const d = new Date(epochMs || Date.now());
  const ymd = d.toISOString().slice(0, 10); // YYYY-MM-DD
  return path.join(projectRoot, "data", "media", ymd);
}

// Build a default filename. msgId is required (its last 10 chars are the
// uniqueness guarantee). Returns just the basename, no folder.
export function defaultFilename({ epochMs, chatName, senderName, msgId, mimeType, kind }) {
  const ts = tsForFilename(epochMs);
  const chatSlug = slug(chatName, 30);
  const senderSlug = slug(senderName, 20);
  const idTail = String(msgId || "").slice(-10) || "noid";
  const ext = extFor(mimeType, kind);
  return `${ts}__${chatSlug}__${senderSlug}__${idTail}.${ext}`;
}

// Validate a user-supplied folder. Returns either:
//   { ok: true, folder: <absolute> }  OR
//   { ok: false, code, error }
// Rules:
//   - If folder is undefined/empty, returns the default folder for `now` epoch.
//   - If folder is relative, resolved against projectRoot.
//   - Must be inside an allowed set of roots (projectRoot, user-home).
//     This is a soft check (warning-level): we allow ANY absolute path the
//     bridge process can write to, because the user explicitly asked for it.
//     But we forbid '..' segments after resolution (path traversal).
export function resolveFolder({ projectRoot, folder, epochMs }) {
  if (!folder || !folder.trim()) {
    return { ok: true, folder: defaultMediaFolder(projectRoot, epochMs) };
  }
  const trimmed = folder.trim();
  let resolved;
  try {
    resolved = path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(projectRoot, trimmed);
  } catch (e) {
    return { ok: false, code: "invalid_argument", error: `cannot resolve folder: ${e?.message || e}` };
  }
  // Refuse anything that looks like path-traversal escape from the input.
  if (trimmed.includes("..")) {
    return { ok: false, code: "invalid_argument", error: "folder contains '..' (path traversal not allowed)" };
  }
  return { ok: true, folder: resolved };
}

// Validate a user-supplied filename. Same shape return.
export function validateFilename(name) {
  if (!name) return { ok: true, filename: null };
  const trimmed = String(name).trim();
  if (!trimmed) return { ok: true, filename: null };
  if (trimmed.includes("/") || trimmed.includes("\\")) {
    return { ok: false, code: "invalid_argument", error: "filename must not contain path separators (use `folder` to choose location)" };
  }
  if (trimmed.includes("..")) {
    return { ok: false, code: "invalid_argument", error: "filename cannot contain '..'" };
  }
  // Windows-illegal chars
  if (/[<>:"|?*\x00-\x1f]/.test(trimmed)) {
    return { ok: false, code: "invalid_filename", error: "filename contains characters not allowed on Windows" };
  }
  if (trimmed.length > 200) {
    return { ok: false, code: "invalid_filename", error: "filename too long (>200 chars)" };
  }
  return { ok: true, filename: trimmed };
}

// Ensure the target folder exists. Returns { ok:true } or a fail envelope.
export function ensureFolder(folderAbs) {
  try {
    fs.mkdirSync(folderAbs, { recursive: true });
    return { ok: true };
  } catch (e) {
    if (e?.code === "EACCES" || e?.code === "EPERM") {
      return { ok: false, code: "permission_denied", error: `cannot create folder ${folderAbs}: ${e.message}` };
    }
    if (e?.code === "ENOSPC") {
      return { ok: false, code: "disk_full", error: e.message };
    }
    return { ok: false, code: "disk_error", error: `mkdir failed for ${folderAbs}: ${e?.message || e}` };
  }
}
