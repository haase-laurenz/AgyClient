#!/usr/bin/env bash
# ==============================================================================
# AgyClient Startup Script for Linux & macOS
# Usage: ./scripts/start-agyclient.sh [--port 3000] [--host 127.0.0.1] [--open]
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

if [ ! -d "node_modules" ]; then
  echo "[1/3] Installing npm dependencies..."
  npm install
fi

if [ ! -f "apps/server/dist/cli.js" ] || [ ! -f "apps/web/dist/index.html" ]; then
  echo "[2/3] Building AgyClient packages, CLI, and web dashboard..."
  npm run build
fi

chmod +x apps/server/dist/cli.js
echo "[3/3] Starting AgyClient..."
exec node apps/server/dist/cli.js start "$@"
