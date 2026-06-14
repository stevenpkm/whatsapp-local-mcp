#!/bin/bash
# WhatsApp MCP - macOS installer.
# Double-click this file, or run:  bash install.command
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MCP_DIR="$(cd "$DIR/.." && pwd)"   # project root is one level up from mac/
cd "$MCP_DIR"

echo "==========================================="
echo "  WhatsApp MCP - Install (macOS)"
echo "==========================================="
echo

# 1) Node.js present + new enough?
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is NOT installed on this Mac."
  echo "It's free and takes ~2 minutes:"
  echo "  1. Go to https://nodejs.org  (opening it now)"
  echo "  2. Download the green LTS .pkg, open it, click Continue / Install"
  echo "  3. Then double-click this installer again"
  open "https://nodejs.org/" >/dev/null 2>&1 || true
  echo
  echo "(You can close this window.)"
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Node.js is too old ($(node -v)). Need v18 or newer - update from https://nodejs.org"
  exit 1
fi

# 2) npm install - ALWAYS, cleanly. A node_modules copied from another machine
#    (e.g. a Linux sandbox) has the wrong native binaries, so never trust it.
if [ -d node_modules ]; then
  echo "[1/2] Removing an existing node_modules (may be built for another OS)..."
  rm -rf node_modules
fi
echo "[1/2] Installing dependencies. Takes 2-5 minutes with no progress bar - it is NOT stuck."
echo
npm install --no-audit --no-fund

# 3) Register the MCP into Cowork / Claude Desktop's config.
#    install-mcp-config.mjs auto-detects macOS (~/Library/Application Support/Claude).
echo
echo "[2/2] Registering the MCP..."
node scripts/install-mcp-config.mjs

echo
echo "(You can close this window now.)"
