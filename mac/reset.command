#!/bin/bash
# Reset WhatsApp MCP (macOS) - nuclear option: stop the bridge and wipe the saved
# WhatsApp credentials (auth/) and local cache (data/). You will re-scan the QR.
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MCP_DIR="$(cd "$DIR/.." && pwd)"
cd "$MCP_DIR"

echo "============================================"
echo "  Reset WhatsApp MCP (nuclear option)"
echo "============================================"
echo "This will:"
echo "  1. Stop the running bridge"
echo "  2. Delete saved credentials (auth/)"
echo "  3. Delete the local message cache (data/)"
echo
echo "Use only if the normal 're-link' in chat is not working."
echo "First: on your phone, WhatsApp -> Settings -> Linked Devices -> log out the Cowork entry."
echo
read -r -p "Type YES to continue: " CONFIRM
if [ "$CONFIRM" != "YES" ]; then
  echo "Aborted. Nothing was changed."
  exit 0
fi

if [ -f data/bridge.pid ]; then kill -9 "$(cat data/bridge.pid)" 2>/dev/null || true; fi
PORTPID="$(lsof -ti tcp:8765 2>/dev/null)"
[ -n "$PORTPID" ] && kill -9 $PORTPID 2>/dev/null || true

rm -rf auth data
echo
echo "Reset complete. Open Cowork and say: scan my WhatsApp"
echo "(You can close this window.)"
