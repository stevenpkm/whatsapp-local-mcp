// Adds (or updates) the "whatsapp" entry in Cowork / Claude Desktop's MCP config.
// Backs up any existing config first.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const indexPath = path.join(projectRoot, "src", "index.js");

const appdata = process.env.APPDATA;
if (!appdata) {
  console.error("ERROR: APPDATA environment variable not set. This script is Windows-only.");
  process.exit(1);
}

// Cowork (research preview) shares the Claude Desktop config file.
const configDir = path.join(appdata, "Claude");
const configPath = path.join(configDir, "claude_desktop_config.json");

console.log("Target config:", configPath);

let config = {};
if (fs.existsSync(configPath)) {
  const backupPath = configPath + ".backup-" + Date.now();
  fs.copyFileSync(configPath, backupPath);
  console.log("Backup saved to:", backupPath);

  try {
    const raw = fs.readFileSync(configPath, "utf8");
    config = raw.trim() ? JSON.parse(raw) : {};
  } catch (e) {
    console.error("ERROR: existing config is not valid JSON:", e.message);
    console.error("Fix or delete it, then re-run.");
    process.exit(1);
  }
} else {
  console.log("No existing config; creating a new one.");
}

if (!config.mcpServers || typeof config.mcpServers !== "object") {
  config.mcpServers = {};
}

const before = JSON.stringify(config.mcpServers.whatsapp || null);
config.mcpServers.whatsapp = {
  command: "node",
  args: [indexPath],
};
const after = JSON.stringify(config.mcpServers.whatsapp);

fs.mkdirSync(configDir, { recursive: true });
fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

if (before === after) {
  console.log("OK: config already had this whatsapp entry; no changes needed.");
} else {
  console.log("OK: whatsapp entry written.");
  console.log("    args[0] =", indexPath);
}
