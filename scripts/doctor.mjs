// One-shot health check for the WhatsApp MCP. Run:  node scripts/doctor.mjs
//
// Prints, in plain language:
//   - Node version (and whether it's new enough)
//   - Whether the global Cowork/Claude config has the whatsapp entry, and
//     whether the path it points at actually exists
//   - Whether the bridge is reachable on 127.0.0.1:8765
//   - WhatsApp connection status + cache size, if the bridge answers
//
// Turns "is it even registered / connected?" into one command.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const PORT = Number(process.env.WHATSAPP_BRIDGE_PORT) || 8765;
const BRIDGE = `http://127.0.0.1:${PORT}`;

const ok = (s) => `  [OK]   ${s}`;
const bad = (s) => `  [FAIL] ${s}`;
const info = (s) => `  [..]   ${s}`;

function globalConfigPath() {
  if (process.platform === "win32") {
    const appdata = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appdata, "Claude", "claude_desktop_config.json");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  return path.join(os.homedir(), ".config", "Claude", "claude_desktop_config.json");
}

async function getJson(url, timeoutMs = 2500) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

console.log("WhatsApp MCP - doctor");
console.log("=====================");

// 1. Node
const major = Number(process.versions.node.split(".")[0]);
console.log(major >= 18 ? ok(`Node ${process.version}`) : bad(`Node ${process.version} - need v18+`));

// 2. Global config registration
const cfgPath = globalConfigPath();
let entry = null;
try {
  const c = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  entry = c?.mcpServers?.whatsapp || null;
} catch {}
if (!entry) {
  console.log(bad(`not registered in ${cfgPath}`));
  console.log(info(process.platform === "darwin"
    ? "double-click INSTALL.command to register it"
    : "double-click INSTALL.bat to register it"));
} else {
  const target = entry.args?.[0] || "(none)";
  const exists = target !== "(none)" && fs.existsSync(target);
  console.log(ok(`registered -> ${target}`));
  console.log(exists ? ok("that index.js exists") : bad("that path does NOT exist - reinstall / re-register"));
}

// 3 + 4. Bridge + connection
const health = await getJson(`${BRIDGE}/healthz`);
if (!health) {
  console.log(bad(`bridge not answering on ${BRIDGE}`));
  console.log(info("it starts when Cowork launches the MCP - fully quit + reopen Cowork"));
} else {
  console.log(ok(`bridge alive on ${BRIDGE} (pid ${health.pid})`));
  const status = await getJson(`${BRIDGE}/status`);
  if (status) {
    console.log(status.connected ? ok("WhatsApp connected") : bad("WhatsApp NOT connected - say: scan my WhatsApp"));
    const cache = status.cache || {};
    console.log(info(`cache: ${cache.messages ?? "?"} messages, ${cache.chats ?? "?"} chats`));
    if (status.looksStale) console.log(info("looks stale - a reconnect may be in progress"));
  }
}

console.log("");
console.log(`(project: ${projectRoot})`);
