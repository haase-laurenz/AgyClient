#!/usr/bin/env bash
# ==============================================================================
# AgyClient — Linux & macOS Command-Line Installer
# Usage:
#   ./scripts/install.sh               # Install & link 'agyclient' into ~/.local/bin
#   ./scripts/install.sh --global      # Also run 'npm link' globally
#   ./scripts/install.sh --uninstall   # Remove 'agyclient' and 'agy-client' links
# ==============================================================================
set -euo pipefail

BIN_DIR="${AGYCLIENT_BIN_DIR:-$HOME/.local/bin}"
INSTALL_GLOBAL=0
UNINSTALL=0

for arg in "$@"; do
  case "$arg" in
    --global|-g)
      INSTALL_GLOBAL=1
      ;;
    --uninstall|--remove)
      UNINSTALL=1
      ;;
    --help|-h)
      echo "AgyClient Installer for Linux & macOS"
      echo ""
      echo "Usage:"
      echo "  ./scripts/install.sh               Build and install 'agyclient' to ~/.local/bin"
      echo "  ./scripts/install.sh --global      Build and link globally via 'npm link' + ~/.local/bin"
      echo "  ./scripts/install.sh --uninstall   Remove installed CLI links"
      exit 0
      ;;
  esac
done

if [ "$UNINSTALL" -eq 1 ]; then
  echo "Removing AgyClient CLI symlinks from $BIN_DIR..."
  rm -f "$BIN_DIR/agyclient" "$BIN_DIR/agy-client"
  echo "Done."
  exit 0
fi

echo "========================================================"
echo "  AgyClient Installer (Linux / macOS)"
echo "========================================================"

# 1. Verify Node.js >= 22.5.0
if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js is not installed. Please install Node.js >= 22.5.0 first." >&2
  exit 1
fi

NODE_VER="$(node -p "process.versions.node")"
NODE_OK="$(node -p "const [maj, min] = process.versions.node.split('.').map(Number); maj > 22 || (maj === 22 && min >= 5) ? 'yes' : 'no'")"
if [ "$NODE_OK" != "yes" ]; then
  echo "[ERROR] Node.js >= 22.5.0 is required (found v${NODE_VER})." >&2
  exit 1
fi
echo "[1/4] Verified Node.js v${NODE_VER}"

# 2. Locate or clone repository root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
if [ -f "$SCRIPT_DIR/../package.json" ]; then
  REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
else
  REPO_ROOT="${AGYCLIENT_INSTALL_DIR:-$HOME/.local/share/agyclient}"
  REPO_URL="${AGYCLIENT_REPO_URL:-https://github.com/haase-laurenz/AgyClient.git}"
  if [ ! -d "$REPO_ROOT" ]; then
    echo "Cloning AgyClient from $REPO_URL into $REPO_ROOT..."
    git clone "$REPO_URL" "$REPO_ROOT"
  else
    echo "Updating existing AgyClient checkout in $REPO_ROOT..."
    git -C "$REPO_ROOT" pull --ff-only || true
  fi
fi

cd "$REPO_ROOT"

# 3. Install dependencies and build packages + server + web UI
echo "[2/4] Installing npm dependencies in $REPO_ROOT..."
npm install

echo "[3/4] Building AgyClient packages, CLI, and web dashboard..."
npm run build

CLI_ENTRY="$REPO_ROOT/apps/server/dist/cli.js"
chmod +x "$CLI_ENTRY"

# 4. Create executable wrappers in ~/.local/bin (and optional npm link)
echo "[4/4] Installing 'agyclient' and 'agy-client' into $BIN_DIR..."
mkdir -p "$BIN_DIR"

cat > "$BIN_DIR/agyclient" <<EOF
#!/usr/bin/env bash
exec node "$CLI_ENTRY" "\$@"
EOF
chmod +x "$BIN_DIR/agyclient"

ln -sf "$BIN_DIR/agyclient" "$BIN_DIR/agy-client"

if [ "$INSTALL_GLOBAL" -eq 1 ]; then
  echo "Linking globally via npm link..."
  npm link || true
fi

echo ""
echo "========================================================"
echo "  AgyClient installed successfully!"
echo "========================================================"
echo "  Binary location : $BIN_DIR/agyclient"
echo "  Alias           : $BIN_DIR/agy-client"
echo ""
if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  echo "  NOTE: Add $BIN_DIR to your PATH if not already present:"
  echo "    export PATH=\"$BIN_DIR:\$PATH\""
  echo ""
fi
echo "  Quick commands:"
echo "    agyclient start --open      # Launch Web Control Center at http://127.0.0.1:3000"
echo "    agyclient doctor            # Verify agy CLI, Git, Node & OS protections"
echo "    agyclient status            # View active agents, permissions & token usage"
echo "    agyclient run \"<prompt>\"    # Run a managed agent directly in the terminal"
echo "    agyclient --help            # Show all CLI commands and options"
echo "========================================================"
