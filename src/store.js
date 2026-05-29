// Local WhatsApp message + chat cache.
// Persists to data/store.json with a .backup alongside for crash safety.
import fs from "node:fs";
import path from "node:path";

const MAX_MESSAGES = 100000;

// ---------- helpers ----------

function formatBytes(n) {
  if (!n || n <= 0) return "";
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

function formatDuration(s) {
  if (!s || s <= 0) return "";
  const sec = Math.round(s);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const r = sec % 60;
  return r ? `${m}m${r}s` : `${m}m`;
}

function unwrap(m) {
  if (!m || typeof m !== "object") return m;
  const wrappers = [
    "ephemeralMessage", "viewOnceMessage", "viewOnceMessageV2",
    "viewOnceMessageV2Extension", "documentWithCaptionMessage",
    "editedMessage", "futureProofMessage", "deviceSentMessage",
  ];
  for (const w of wrappers) {
    if (m[w]?.message) return unwrap(m[w].message);
  }
  return m;
}

const STUB_LABELS = {
  1: "[revoked]", 2: "[ciphertext]", 4: "[future-version system message]",
  20: "[group created]", 21: "[group name changed]", 22: "[group description changed]",
  23: "[group picture changed]", 24: "[group settings changed]",
  27: "[participant added]", 28: "[participant removed]",
  29: "[participant promoted to admin]", 30: "[participant demoted from admin]",
  31: "[participant invited]", 32: "[participant left]",
  46: "[E2E encryption notification]",
  50: "[call missed (voice)]", 51: "[call missed (video)]",
  56: "[group invite link reset]", 57: "[changed phone number]",
  58: "[blocked contact]", 59: "[unblocked contact]",
  68: "[business account changed]", 69: "[message deleted by admin]",
  71: "[disappearing messages enabled]", 72: "[disappearing messages disabled]",
  73: "[disappearing messages duration changed]",
};

// Convert Buffer/Uint8Array to base64 so we can JSON-persist crypto keys.
function bufToB64(v) {
  if (!v) return undefined;
  if (typeof v === "string") return v;
  if (Buffer.isBuffer(v)) return v.toString("base64");
  if (v instanceof Uint8Array) return Buffer.from(v).toString("base64");
  return undefined;
}

// Pull the cryptographic media-download fields from a message proto. Used
// so we can later call Baileys' downloadContentFromMessage on demand.
export function extractMediaFields(m) {
  if (!m || typeof m !== "object") return null;
  const variants = [
    ["imageMessage", "image"],
    ["videoMessage", "video"],
    ["audioMessage", "audio"],
    ["documentMessage", "document"],
    ["stickerMessage", "sticker"],
  ];
  for (const [field, kind] of variants) {
    const v = m[field];
    if (!v || !v.mediaKey) continue;
    return {
      kind,
      url: v.url || undefined,
      directPath: v.directPath || undefined,
      mediaKey: bufToB64(v.mediaKey),
      fileSha256: bufToB64(v.fileSha256),
      fileEncSha256: bufToB64(v.fileEncSha256),
      fileLength: Number(v.fileLength) || undefined,
      mediaKeyTimestamp: Number(v.mediaKeyTimestamp) || undefined,
      mimetype: v.mimetype || undefined,
      seconds: Number(v.seconds) || undefined,
      ptt: !!v.ptt,
      fileName: v.fileName || undefined,
      width: Number(v.width) || undefined,
      height: Number(v.height) || undefined,
    };
  }
  return null;
}

function extractText(m) {
  if (!m || typeof m !== "object") return null;
  if (typeof m.conversation === "string" && m.conversation.length) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;

  if (m.imageMessage) {
    const cap = m.imageMessage.caption;
    const size = formatBytes(Number(m.imageMessage.fileLength));
    const dims = m.imageMessage.width && m.imageMessage.height
      ? `${m.imageMessage.width}x${m.imageMessage.height}` : "";
    const meta = [dims, size].filter(Boolean).join(", ");
    return cap ? `[image${meta ? " " + meta : ""}] ${cap}` : `[image${meta ? " " + meta : ""}]`;
  }
  if (m.videoMessage) {
    const cap = m.videoMessage.caption;
    const dur = formatDuration(Number(m.videoMessage.seconds));
    const size = formatBytes(Number(m.videoMessage.fileLength));
    const meta = [dur, size].filter(Boolean).join(", ");
    const tag = m.videoMessage.gifPlayback ? "gif" : "video";
    return cap ? `[${tag}${meta ? " " + meta : ""}] ${cap}` : `[${tag}${meta ? " " + meta : ""}]`;
  }
  if (m.audioMessage) {
    const dur = formatDuration(Number(m.audioMessage.seconds));
    const size = formatBytes(Number(m.audioMessage.fileLength));
    const meta = [dur, size].filter(Boolean).join(", ");
    const tag = m.audioMessage.ptt ? "voice note" : "audio";
    return `[${tag}${meta ? " " + meta : ""}]`;
  }
  if (m.stickerMessage) return m.stickerMessage.isAnimated ? "[animated sticker]" : "[sticker]";
  if (m.documentMessage) {
    const name = m.documentMessage.fileName || "file";
    const size = formatBytes(Number(m.documentMessage.fileLength));
    const cap = m.documentMessage.caption;
    const head = `[document: ${name}${size ? `, ${size}` : ""}]`;
    return cap ? `${head} ${cap}` : head;
  }
  if (m.contactMessage) return `[contact card: ${m.contactMessage.displayName || "(unnamed)"}]`;
  if (m.contactsArrayMessage) {
    const n = m.contactsArrayMessage.contacts?.length || 0;
    return `[contacts: ${n} card${n === 1 ? "" : "s"}]`;
  }
  if (m.locationMessage) {
    const lat = m.locationMessage.degreesLatitude;
    const lon = m.locationMessage.degreesLongitude;
    const name = m.locationMessage.name;
    return name ? `[location: ${name}]` : `[location: ${lat?.toFixed(4)}, ${lon?.toFixed(4)}]`;
  }
  if (m.liveLocationMessage) return "[live location]";
  const poll = m.pollCreationMessage || m.pollCreationMessageV2 || m.pollCreationMessageV3;
  if (poll) {
    const opts = (poll.options || []).map((o) => o.optionName).filter(Boolean);
    const optStr = opts.length ? ` - ${opts.join(" / ")}` : "";
    return `[poll: ${poll.name || ""}${optStr}]`;
  }
  if (m.pollUpdateMessage) return "[poll vote]";
  if (m.reactionMessage) {
    const emoji = m.reactionMessage.text;
    return emoji ? `[reaction: ${emoji}]` : "[reaction removed]";
  }
  if (m.groupInviteMessage) return `[group invite: ${m.groupInviteMessage.groupName || ""}]`;
  if (m.buttonsResponseMessage) return `[button reply: ${m.buttonsResponseMessage.selectedDisplayText || m.buttonsResponseMessage.selectedButtonId || ""}]`;
  if (m.listResponseMessage) {
    const sel = m.listResponseMessage.singleSelectReply?.selectedRowId;
    return `[list reply: ${m.listResponseMessage.title || sel || ""}]`;
  }
  if (m.templateButtonReplyMessage) return `[template reply: ${m.templateButtonReplyMessage.selectedDisplayText || ""}]`;
  if (m.interactiveResponseMessage) return "[interactive response]";
  if (m.orderMessage) return `[order: ${m.orderMessage.orderTitle || ""}]`;
  if (m.productMessage) return `[product: ${m.productMessage.product?.title || ""}]`;
  if (m.paymentInviteMessage) return "[payment invite]";
  if (m.sendPaymentMessage) return "[payment sent]";
  if (m.requestPaymentMessage) return "[payment requested]";
  if (m.call) return "[call]";
  if (m.protocolMessage) {
    const t = m.protocolMessage.type;
    if (t === 0) return "[message deleted]";
    if (t === 14) return "[edited]";
    return null;
  }
  return null;
}

export class Store {
  constructor(dir = "data") {
    this.dir = dir;
    this.file = path.join(dir, "store.json");
    this.messages = [];
    this.chats = new Map();
    this.contacts = new Map();
    this._idIndex = new Map();
    this._saveTimer = null;
    fs.mkdirSync(dir, { recursive: true });
    this._load();
  }

  _load() {
    const candidates = [this.file, this.file + ".backup"];
    for (const p of candidates) {
      if (!fs.existsSync(p)) continue;
      try {
        const data = JSON.parse(fs.readFileSync(p, "utf8"));
        this.messages = Array.isArray(data.messages) ? data.messages : [];
        this.chats = new Map(data.chats || []);
        this.contacts = new Map(data.contacts || []);
        this._idIndex = new Map();
        for (let i = 0; i < this.messages.length; i++) {
          const m = this.messages[i];
          if (m?.chatId && m?.id) this._idIndex.set(`${m.chatId}|${m.id}`, i);
        }
        if (p !== this.file) {
          console.error(`[store] loaded from backup (${p}); main file was unreadable.`);
        }
        return;
      } catch (e) {
        console.error(`[store] failed to load ${p}: ${e.message}`);
      }
    }
    console.error("[store] starting with empty cache");
  }

  _save() {
    let toSave = this.messages;
    if (toSave.length > MAX_MESSAGES) {
      toSave = [...toSave].sort((a, b) => b.timestamp - a.timestamp).slice(0, MAX_MESSAGES);
    }
    const json = JSON.stringify({
      messages: toSave,
      chats: Array.from(this.chats.entries()),
      contacts: Array.from(this.contacts.entries()),
    });
    const tmp = this.file + ".tmp";
    const backup = this.file + ".backup";
    const fd = fs.openSync(tmp, "w");
    try {
      fs.writeSync(fd, json);
      try { fs.fsyncSync(fd); } catch {}
    } finally {
      fs.closeSync(fd);
    }
    if (fs.existsSync(this.file)) {
      try { fs.copyFileSync(this.file, backup); } catch {}
    }
    fs.renameSync(tmp, this.file);
  }

  _scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      try { this._save(); } catch (e) { console.error("[store] save:", e.message); }
    }, 2000);
  }

  upsertChat(chat) {
    if (!chat?.id) return;
    const prev = this.chats.get(chat.id) || {};
    this.chats.set(chat.id, {
      id: chat.id,
      name: chat.name || chat.subject || prev.name,
      isGroup: chat.id.endsWith("@g.us"),
      lastSeen: prev.lastSeen || 0,
    });
    this._scheduleSave();
  }

  upsertContact(contact) {
    if (!contact?.id) return;
    const name = contact.name || contact.notify || contact.verifiedName;
    if (!name) return;
    this.contacts.set(contact.id, { id: contact.id, name });
    this._scheduleSave();
  }

  addMessage(msg) {
    const key = msg?.key;
    if (!key?.id || !key?.remoteJid) return;
    if (key.remoteJid === "status@broadcast") return;
    if (key.remoteJid === "broadcast") return;

    const chatId = key.remoteJid;
    const isGroup = chatId.endsWith("@g.us");
    const ts = (Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000)) * 1000;

    let text = null;
    let type = "unknown";

    if (msg.messageStubType && !msg.message) {
      const NOISE_STUBS = new Set([2, 4, 46]);
      if (NOISE_STUBS.has(msg.messageStubType)) return;
      text = STUB_LABELS[msg.messageStubType] || `[system: stubType=${msg.messageStubType}]`;
      type = "system";
    } else {
      const raw = msg.message;
      if (!raw || Object.keys(raw).length === 0) return;
      const m = unwrap(raw);
      if (!m || Object.keys(m).length === 0) return;
      if (m.albumMessage && !m.imageMessage && !m.videoMessage && !m.conversation) return;
      if (m.protocolMessage) {
        const t = m.protocolMessage.type;
        if (t !== 0 && t !== 14) return;
      }
      if (m.senderKeyDistributionMessage && Object.keys(m).length === 1) return;
      if (m.messageContextInfo && Object.keys(m).length === 1) return;

      text = extractText(m);
      if (text === null) {
        const keys = Object.keys(m).filter(
          (k) => k !== "messageContextInfo" && k !== "senderKeyDistributionMessage"
        );
        text = `[unhandled: ${keys.join(",") || "empty"}]`;
        type = "unhandled";
      } else {
        type = Object.keys(m).find(
          (k) => k !== "messageContextInfo" && k !== "senderKeyDistributionMessage"
        ) || "text";
      }
    }

    // Capture media keys for later download/enrich.
    let media = null;
    if (msg.message) {
      try { media = extractMediaFields(unwrap(msg.message)); } catch {}
    }

    const idxKey = `${chatId}|${key.id}`;
    const entry = {
      id: key.id,
      chatId,
      isGroup,
      fromMe: !!key.fromMe,
      sender: key.participant || (key.fromMe ? "me" : chatId),
      text,
      type,
      timestamp: ts,
      ...(media ? { media } : {}),
    };

    const existingIdx = this._idIndex.get(idxKey);
    if (existingIdx !== undefined && this.messages[existingIdx]) {
      const prev = this.messages[existingIdx];
      if (prev.transcript) entry.transcript = prev.transcript;
      if (prev.description) entry.description = prev.description;
      if (!entry.media && prev.media) entry.media = prev.media;
      this.messages[existingIdx] = entry;
    } else {
      this._idIndex.set(idxKey, this.messages.length);
      this.messages.push(entry);
    }

    const chat = this.chats.get(chatId) || { id: chatId, isGroup };
    chat.lastSeen = Math.max(chat.lastSeen || 0, ts);
    this.chats.set(chatId, chat);

    this._scheduleSave();
  }

  setTranscript(chatId, msgId, transcript) {
    const idxKey = `${chatId}|${msgId}`;
    const idx = this._idIndex.get(idxKey);
    if (idx === undefined) return false;
    const m = this.messages[idx];
    if (!m) return false;
    m.transcript = transcript;
    const tagMatch = String(m.text || "").match(/^(\[(?:voice note|audio)[^\]]*\])/);
    const tag = tagMatch ? tagMatch[1] : "[voice note]";
    m.text = `${tag} ${transcript}`.trim();
    this._scheduleSave();
    return true;
  }

  setDescription(chatId, msgId, description) {
    const idxKey = `${chatId}|${msgId}`;
    const idx = this._idIndex.get(idxKey);
    if (idx === undefined) return false;
    const m = this.messages[idx];
    if (!m) return false;
    m.description = description;
    const tagMatch = String(m.text || "").match(/^(\[(?:image|video|sticker)[^\]]*\])(.*)$/);
    if (tagMatch) {
      const tag = tagMatch[1];
      const caption = (tagMatch[2] || "").trim();
      m.text = caption ? `${tag} ${caption} - ${description}` : `${tag} ${description}`;
    } else {
      m.text = description;
    }
    this._scheduleSave();
    return true;
  }

  // Iterate messages in a time window that have media keys but no
  // enrichment yet (no transcript/description). Used by /enrich-window.
  listUnenrichedMedia({ hours = 24, kinds = ["image", "audio"] } = {}) {
    const cutoff = Date.now() - hours * 3600 * 1000;
    const out = [];
    for (const m of this.messages) {
      if (!m?.media || !m.media.mediaKey) continue;
      if (m.timestamp < cutoff) continue;
      if (!kinds.includes(m.media.kind)) continue;
      if (m.media.kind === "audio" && m.transcript) continue;
      if (m.media.kind === "image" && m.description) continue;
      out.push(m);
    }
    return out;
  }

  nameFor(jid) {
    if (!jid) return "(unknown)";
    if (jid === "me") return "you";
    const chat = this.chats.get(jid);
    if (chat?.name) return chat.name;
    const contact = this.contacts.get(jid);
    if (contact?.name) return contact.name;
    return jid.split("@")[0];
  }

  listChats({ excludeGroups = false } = {}) {
    const out = [];
    for (const chat of this.chats.values()) {
      if (excludeGroups && chat.isGroup) continue;
      out.push({
        id: chat.id,
        name: this.nameFor(chat.id),
        isGroup: chat.isGroup,
        lastSeenISO: chat.lastSeen ? new Date(chat.lastSeen).toISOString() : null,
      });
    }
    out.sort((a, b) => (b.lastSeenISO || "").localeCompare(a.lastSeenISO || ""));
    return out;
  }

  _formatRow(m) {
    return {
      chat: this.nameFor(m.chatId),
      from: m.fromMe ? "you" : this.nameFor(m.sender),
      text: m.text,
      type: m.type,
      timeISO: new Date(m.timestamp).toISOString(),
      isGroup: m.isGroup,
      transcript: m.transcript || undefined,
      description: m.description || undefined,
      hasMedia: m.media ? true : undefined,
      msgId: m.id,
    };
  }

  getRecentMessages({ hours = 24, excludeGroups = false, chatId = null, limit = 500 } = {}) {
    const cutoff = Date.now() - hours * 3600 * 1000;
    const matches = [];
    for (const m of this.messages) {
      if (!m || typeof m.timestamp !== "number") continue;
      if (m.timestamp < cutoff) continue;
      if (excludeGroups && m.isGroup) continue;
      if (chatId && m.chatId !== chatId) continue;
      matches.push(m);
    }
    matches.sort((a, b) => a.timestamp - b.timestamp);
    return matches.slice(-limit).map((m) => this._formatRow(m));
  }

  searchMessages({ query, hours = 720, excludeGroups = false, limit = 100 } = {}) {
    const q = query.toLowerCase();
    const cutoff = Date.now() - hours * 3600 * 1000;
    const matches = [];
    for (const m of this.messages) {
      if (!m || typeof m.timestamp !== "number") continue;
      if (m.timestamp < cutoff) continue;
      if (excludeGroups && m.isGroup) continue;
      if (!m.text || !m.text.toLowerCase().includes(q)) continue;
      matches.push(m);
    }
    matches.sort((a, b) => a.timestamp - b.timestamp);
    return matches.slice(-limit).map((m) => this._formatRow(m));
  }
}
