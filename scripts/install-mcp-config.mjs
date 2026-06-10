// Registers the "whatsapp" MCP server so Cowork / Claude Desktop will launch it.
//
// IMPORTANT: this must run ON THE MACHINE where Cowork/Claude Desktop is
// installed (i.e. via windows/install.bat on Windows). A Cowork agent in its
// sandbox CANNOT run this usefully: it can't reach Cowork's protected global
// config, and Cowork does NOT read a project-scoped .mcp.json. So this is a
// Windows-host step, not an agent step.
//
// What it does: merge a "whatsapp" entry into the global config
// (%APPDATA%\Claude\claude_desktop_config.json on Windows). Backs the file up
// first, never clobbers other servers. Idempotent. Cross-platform (also targets
// the right config dir on macOS/Linux).

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const indexPath = path.join(projectRoot, "src", "index.js");

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
  return path.join(os.homedir(), ".config", "Claude", "claude_desktop_config.json");
}

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

// ---- run ----------------------------------------------------------------
console.log("Registering the WhatsApp MCP...");
console.log("  server entry: node", indexPath);
console.log("");

const configPath = globalConfigPath();

try {
  const result = mergeIntoConfig(configPath);
  if (result === "already") {
    console.log("OK - config already had the whatsapp entry. No change needed.");
  } else {
    console.log("OK - whatsapp entry written to the Claude/Cowork config:");
    console.log("     " + configPath);
  }
} catch (e) {
  console.error("FAILED to write the global config:", e.message);
  console.error("");
  console.error("This script must run on the machine where Cowork/Claude Desktop");
  console.error("is installed (run windows\\install.bat by double-clicking it).");
  console.error("Target config: " + configPath);
  process.exit(1);
}

console.log("");
console.log("=========================================================");
console.log(" Installed. Two more steps - both on your side:");
console.log("  1. FULLY quit Cowork (tray icon -> Quit, not just close)");
console.log("     and open it again.");
console.log("  2. In the chat, say:  scan my WhatsApp");
console.log("=========================================================");
process.exit(0);
