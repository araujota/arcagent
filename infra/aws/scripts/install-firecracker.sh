#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Install Firecracker and Jailer binaries
# ---------------------------------------------------------------------------
# Usage: bash install-firecracker.sh [VERSION]
# ---------------------------------------------------------------------------
set -euo pipefail

VERSION="${1:-1.10.1}"
ARCH="x86_64"
INSTALL_DIR="/usr/local/bin"

echo "Installing Firecracker v$VERSION for $ARCH..."

# Check if already installed at correct version
if command -v firecracker &>/dev/null; then
  CURRENT=$(firecracker --version 2>/dev/null | head -1 | grep -oP '[\d.]+' || echo "unknown")
  if [ "$CURRENT" = "$VERSION" ]; then
    echo "Firecracker v$VERSION already installed."
    exit 0
  fi
  echo "Upgrading Firecracker from v$CURRENT to v$VERSION..."
fi

# Download release archive
RELEASE_URL="https://github.com/firecracker-microvm/firecracker/releases/download/v$VERSION/firecracker-v$VERSION-$ARCH.tgz"
TMP_DIR=$(mktemp -d)
trap 'rm -rf $TMP_DIR' EXIT

echo "Downloading from $RELEASE_URL..."
curl -fsSL -o "$TMP_DIR/firecracker.tgz" "$RELEASE_URL"

# Extract
tar -xzf "$TMP_DIR/firecracker.tgz" -C "$TMP_DIR"

# Find and install binaries
FC_BIN=$(find "$TMP_DIR" -name "firecracker-v*" -type f ! -name "*.tgz" | head -1)
JAILER_BIN=$(find "$TMP_DIR" -name "jailer-v*" -type f | head -1)

if [ -z "$FC_BIN" ] || [ -z "$JAILER_BIN" ]; then
  echo "ERROR: Could not find firecracker or jailer in release archive."
  ls -la "$TMP_DIR"/
  exit 1
fi

cp "$FC_BIN" "$INSTALL_DIR/firecracker"
cp "$JAILER_BIN" "$INSTALL_DIR/jailer"
chmod 755 "$INSTALL_DIR/firecracker" "$INSTALL_DIR/jailer"

# Verify installation
echo "Installed:"
echo "  firecracker: $($INSTALL_DIR/firecracker --version 2>&1 | head -1)"
echo "  jailer:      $($INSTALL_DIR/jailer --version 2>&1 | head -1)"

# Set capabilities so jailer can run without full root
# (the worker process runs as arcagent but jailer needs cap_sys_admin, cap_net_admin)
setcap 'cap_sys_admin,cap_net_admin,cap_sys_chroot,cap_setuid,cap_setgid+eip' "$INSTALL_DIR/jailer" 2>/dev/null || \
  echo "WARNING: setcap failed — jailer will need to run as root or with sudo"

echo "Firecracker v$VERSION installation complete."
