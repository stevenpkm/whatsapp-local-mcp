// Registers the "whatsapp" MCP server so Cowork / Claude Desktop will launch it.
//
// Designed to be run by the Cowork agent itself (no .bat, no admin, no
// computer-use). It tries the proven path first and falls back automatically:
//
//   1. PRIMARY  - merge a "whatsapp" entry into the global config
//                 (%APPDATA%\Claude\claude_desktop_config.json). Confirmed:
//                 Cowork reads this. Backs the file up first, never clobbers
//                 other servers.
//   2. FALLBACK - if the global file can't be written (locked-down
//                 permissions), drop a project-local `.mcp.json` next to the
//                 code instead, so a project-scoped client can still find it.
//
// Idempotent: running it twice changes nothing the second time.
// Cross-platform: on macOS/Linux it targets the right config dir too.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const indexPath = path.join(projectRoot, "src", "index.js");

// The single source of truth for what we register, reused by both paths.
const SERVER_ENTRY = { command: "node", args: [indexPath] };

// ---- locate the global config for this OS -------------------------------
function globalConfigPath() {
  if (process.platform === "win32") {
    const appdata = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appdata, "Claude", "claude_desktop_config.json");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  // Linux / other
  return path.join(os.homedir(), ".config", "Claude", "claude_desktop_config.json");
}

// ---- helpers ------------------------------------------------------------
function readJsonIfAny(file) {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, "utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw); // may throw -> caller handles
}

// Returns "written" | "already" (throws on real IO/permission failure).
function mergeIntoConfig(configPath) {
  const dir = path.dirname(configPath);

  let config = {};
  if (fs.existsSync(configPath)) {
    // Back up before touching an existing file.
    const backup = `${configPath}.backup-${process.pid}-${indexPath.length}`;
    try { fs.copyFileSync(configPath, backup); } catch {}
    try {
      config = readJsonIfAny(configPath);
    } catch (e) {
      throw new Error(`existing config is not valid JSON (${e.message}). Fix or delete: ${configPath}`);
    }
  }

  if (!config.mcpServers || typeof config.mcpServers !== "object") config.mcpServers = {};

  const before = JSON.stringify(config.mcpServers.whatsapp || null);
  config.mcpServers.whatsapp = SERVER_ENTRY;
  const after = JSON.stringify(config.mcpServers.whatsapp);

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return before === after ? "already" : "written";
}

// Fallback: a project-scoped .mcp.json next to the code.
function writeProjectMcpJson() {
  const file = path.join(projectRoot, ".mcp.json");
  let config = {};
  try { config = readJsonIfAny(file); } catch { config = {}; }
  if (!config.mcpServers || typeof config.mcpServers !== "object") config.mcpServers = {};
  config.mcpServers.whatsapp = SERVER_ENTRY;
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
  return file;
}

// ---- run ----------------------------------------------------------------
console.log("Registering the WhatsApp MCP...");
console.log("  server entry: node", indexPath);
console.log("");

const configPath = globalConfigPath();
let registered = false;

try {
  const result = mergeIntoConfig(configPath);
  registered = true;
  if (result === "already") {
    console.log("OK - config already had the whatsapp entry. No change needed.");
  } else {
    console.log("OK - whatsapp entry written to the Claude/Cowork config:");
    console.log("     " + configPath);
  }
} catch (e) {
  console.error("Could not write the global config:", e.message);
  console.error("Falling back to a project-local .mcp.json instead...");
  try {
    const file = writeProjectMcpJson();
    registered = true;
    console.log("OK - wrote " + file);
    console.log("     (Cowork will pick this up when this folder is the open workspace.)");
  } catch (e2) {
    console.error("Fallback also failed:", e2.message);
  }
}

console.log("");
if (registered) {
  console.log("=========================================================");
  console.log(" Installed. Two more steps - both on your side:");
  console.log("  1. FULLY quit Cowork (tray icon -> Quit, not just close)");
  console.log("     and open it again.");
  console.log("  2. In the chat, say:  scan my WhatsApp");
  console.log("=========================================================");
  process.exit(0);
} else {
  console.error("Registration failed by every method. Nothing was installed.");
  process.exit(1);
}
