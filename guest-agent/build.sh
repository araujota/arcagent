#!/usr/bin/env bash
# Cross-compile the guest-agent binary for linux/amd64
# and copy it into the rootfs build context.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUTPUT_DIR="${SCRIPT_DIR}/../worker/rootfs"

echo "==> Building vsock-agent for linux/amd64..."
cd "$SCRIPT_DIR"
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -ldflags="-s -w" -o vsock-agent .

echo "==> Copying vsock-agent to ${OUTPUT_DIR}/"
mkdir -p "$OUTPUT_DIR"
cp vsock-agent "$OUTPUT_DIR/vsock-agent"

echo "==> Done. Binary size: $(du -h vsock-agent | cut -f1)"
rm vsock-agent
