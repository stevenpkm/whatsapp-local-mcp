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

// Register the ABSOLUTE path to this machine's node, NOT a bare "node".
// Claude Desktop / Cowork spawns the MCP server without a shell and without the
// user's full PATH, so a bare "node" silently fails to launch on many Windows
// machines even when `node` works in a terminal - the #1 "installed fine but
// Claude can't detect the bridge" cause (Mac is more forgiving). process.execPath
// is the node that ran this installer, so it's guaranteed correct on this machine.
const SERVER_ENTRY = { command: process.execPath, args: [indexPath] };

// ---- locate the global config for this OS -------------------------------
// Bounded recursive search for claude_desktop_config.json under a directory.
function findConfigUnder(dir, maxDepth = 6) {
  let hit = null;
  (function walk(d, depth) {
    if (hit || depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (hit) return;
      const full = path.join(d, e.name);
      if (e.isFile()) { if (e.name === "claude_desktop_config.json") hit = full; }
      else if (e.isDirectory()) walk(full, depth + 1);
    }
  })(dir, 0);
  return hit;
}

// Windows: the config path is a MOVING TARGET. Both the official claude.ai/download
// installer AND the Microsoft Store build are now MSIX-packaged, so Claude reads its
// config from a VIRTUALIZED path %LOCALAPPDATA%\Packages\<Claude pkg>\LocalCache\
// Roaming\Claude\claude_desktop_config.json - while the in-app "Edit Config" button
// and %APPDATA%\Claude\ point at a DIFFERENT file (users edit one, the app reads the
// other -> "MCP not detected", no error). Machines upgraded from an older non-MSIX
// build still use %APPDATA%\Claude. We can't reliably tell which this machine reads,
// so we WRITE TO ALL candidate files (harmless duplicates) and let Claude pick.
// See anthropics/claude-code#26073 and multiple community write-ups (2026).
function configTargets() {
  if (process.platform === "darwin")
    return [path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json")];
  if (process.platform !== "win32")
    return [path.join(os.homedir(), ".config", "Claude", "claude_desktop_config.json")];

  const appdata = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const targets = [path.join(appdata, "Claude", "claude_desktop_config.json")];
  const packagesDir = path.join(localAppData, "Packages");
  try {
    for (const name of fs.readdirSync(packagesDir)) {
      if (!/claude|anthropic/i.test(name)) continue;
      const pkg = path.join(packagesDir, name);
      const found = findConfigUnder(pkg);
      if (found) targets.push(found);
      targets.push(path.join(pkg, "LocalCache", "Roaming", "Claude", "claude_desktop_config.json"));
    }
  } catch {}
  return [...new Set(targets)];
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
console.log("  server entry:", process.execPath, indexPath);
console.log("");

const targets = configTargets();
const okPaths = [];
const failPaths = [];
for (const t of targets) {
  try {
    mergeIntoConfig(t);
    const check = JSON.parse(fs.readFileSync(t, "utf8"));
    const got = check?.mcpServers?.whatsapp;
    if (!got || got.args?.[0] !== indexPath) throw new Error("entry did not verify after write");
    okPaths.push(t);
  } catch (e) {
    failPaths.push(t + "  ->  " + e.message);
  }
}

if (okPaths.length === 0) {
  console.error("FAILED to register in ANY Claude config location:");
  for (const f of failPaths) console.error("  " + f);
  console.error("");
  console.error("Run this on the machine where Claude Desktop is installed (double-click INSTALL.bat).");
  process.exit(1);
}

console.log("VERIFIED - wrote + confirmed the whatsapp entry in " + okPaths.length + " location(s) Claude may load:");
for (const p of okPaths) console.log("     " + p);
console.log("     whatsapp -> " + process.execPath);
if (failPaths.length) {
  console.log("  (skipped " + failPaths.length + " location(s) that couldn't be written - harmless if the above are correct)");
}

console.log("");
console.log("=========================================================");
console.log(" Installed. Two more steps - both on your side:");
console.log(process.platform === "darwin"
  ? "  1. FULLY quit Cowork (menu-bar icon -> Quit, not just close)"
  : "  1. FULLY quit Cowork (tray icon -> Quit, not just close)");
console.log("     and open it again.");
console.log("  2. In the chat, say:  scan my WhatsApp");
console.log("=========================================================");
process.exit(0);
