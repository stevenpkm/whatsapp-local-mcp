#!/bin/bash
# WhatsApp MCP - double-click to install (macOS).
# (Just runs the real installer in the mac/ folder.)
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$DIR/mac/install.command"
