#!/bin/bash
# Restart the WhatsApp bridge (macOS). Use if Cowork says "server disconnected".
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MCP_DIR="$(cd "$DIR/.." && pwd)"
cd "$MCP_DIR"

echo "Restarting WhatsApp bridge..."

# Stop the old bridge (by PID file, then by port, just in case).
if [ -f data/bridge.pid ]; then
  OLDPID="$(cat data/bridge.pid)"
  if kill -0 "$OLDPID" 2>/dev/null; then kill -9 "$OLDPID" 2>/dev/null && echo "stopped old bridge ($OLDPID)"; fi
  rm -f data/bridge.pid
fi
PORTPID="$(lsof -ti tcp:8765 2>/dev/null)"
[ -n "$PORTPID" ] && kill -9 $PORTPID 2>/dev/null || true

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node.js not found on PATH."
  exit 1
fi

echo "Starting a fresh bridge in the background..."
mkdir -p data
nohup node src/bridge.js >> data/bridge.log 2>&1 &
sleep 2

if curl -s -m 2 http://127.0.0.1:8765/healthz >/dev/null 2>&1; then
  echo "Bridge is up. Logs: $MCP_DIR/data/bridge.log"
else
  echo "Bridge did not answer yet - give it a few seconds, or check data/bridge.log"
fi
echo
echo "(You can close this window.)"
