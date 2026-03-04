#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Build Firecracker rootfs images from Dockerfiles and upload to S3
# ---------------------------------------------------------------------------
# Usage:
#   bash build-and-upload.sh <s3-bucket> [version] [image...]
#
# Examples:
#   bash build-and-upload.sh arcagent-rootfs-production v1
#   bash build-and-upload.sh arcagent-rootfs-production v2 node-20 base
# ---------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
S3_BUCKET="${1:?Usage: build-and-upload.sh <s3-bucket> [version] [image...]}"
VERSION="${2:-v1}"
shift 2 || shift $#

# All available images
ALL_IMAGES=(base node-20 python-312 rust-stable go-122 java-21 ruby-33 php-84 dotnet-9 cpp-gcc14 swift-6 kotlin-jvm21)

# If specific images were requested, use those; otherwise build all
if [ $# -gt 0 ]; then
  IMAGES=("$@")
else
  IMAGES=("${ALL_IMAGES[@]}")
fi

IMAGE_SIZE_MB=4096
OUTPUT_DIR="/tmp/arcagent-rootfs-build"
mkdir -p "$OUTPUT_DIR"
VSOCK_AGENT_BIN="$SCRIPT_DIR/vsock-agent"

cleanup() {
  rm -f "$VSOCK_AGENT_BIN"
}
trap cleanup EXIT

echo ">>> Building vsock-agent binary..."
if ! command -v go >/dev/null 2>&1; then
  echo "ERROR: Go toolchain is required to build worker/vsock-agent."
  exit 1
fi
(
  cd "$REPO_ROOT/worker/vsock-agent"
  CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o "$VSOCK_AGENT_BIN" ./
)

if [ ! -s "$VSOCK_AGENT_BIN" ]; then
  echo "ERROR: Failed to build vsock-agent binary."
  exit 1
fi
if ! file "$VSOCK_AGENT_BIN" | grep -q "ELF 64-bit LSB executable"; then
  echo "ERROR: Built vsock-agent is not a Linux ELF binary."
  file "$VSOCK_AGENT_BIN" || true
  exit 1
fi

echo "=== ArcAgent Rootfs Build ==="
echo "Bucket:  s3://$S3_BUCKET/$VERSION/"
echo "Images:  ${IMAGES[*]}"
echo ""

# ---------------------------------------------------------------------------
# Build each image
# ---------------------------------------------------------------------------
for img in "${IMAGES[@]}"; do
  DOCKERFILE="$SCRIPT_DIR/Dockerfile.$img"
  if [ ! -f "$DOCKERFILE" ]; then
    echo "ERROR: $DOCKERFILE not found — skipping $img"
    continue
  fi

  EXT4_PATH="$OUTPUT_DIR/$img.ext4"
  ZST_PATH="$OUTPUT_DIR/$img.ext4.zst"

  echo ">>> [$img] Building Docker image..."
  docker build --platform linux/amd64 -t "arcagent-rootfs-$img" -f "$DOCKERFILE" "$SCRIPT_DIR"

  echo ">>> [$img] Verifying scanner tooling (snyk + sonar-scanner)..."
  docker run --rm --platform linux/amd64 "arcagent-rootfs-$img" bash -lc \
    "command -v snyk >/dev/null 2>&1 && command -v sonar-scanner >/dev/null 2>&1"

  echo ">>> [$img] Exporting filesystem..."
  CID=$(docker create --platform linux/amd64 "arcagent-rootfs-$img")
  docker export "$CID" > "$OUTPUT_DIR/$img.tar"
  docker rm "$CID" > /dev/null

  echo ">>> [$img] Converting to ext4 (${IMAGE_SIZE_MB}MB)..."
  # Use a privileged Linux container to create the ext4 filesystem
  # because macOS cannot mount ext4 natively
  docker run --rm --privileged --platform linux/amd64 \
    -v "$OUTPUT_DIR:/work" \
    ubuntu:22.04 bash -c "
      set -e
      apt-get update -qq && apt-get install -y -qq e2fsprogs > /dev/null 2>&1
      dd if=/dev/zero of=/work/$img.ext4 bs=1M count=$IMAGE_SIZE_MB status=none
      mkfs.ext4 -q -F /work/$img.ext4
      mkdir -p /mnt/rootfs
      mount -o loop /work/$img.ext4 /mnt/rootfs
      tar -xf /work/$img.tar -C /mnt/rootfs 2>/dev/null || true
      # Write DNS config (can't be done in Dockerfile — Docker bind-mounts resolv.conf)
      printf 'nameserver 8.8.8.8\nnameserver 8.8.4.4\n' > /mnt/rootfs/etc/resolv.conf
      umount /mnt/rootfs
      rm /work/$img.tar
    "

  echo ">>> [$img] Compressing with zstd..."
  # Use a container for zstd too (may not be installed on macOS)
  docker run --rm --platform linux/amd64 \
    -v "$OUTPUT_DIR:/work" \
    ubuntu:22.04 bash -c "
      apt-get update -qq && apt-get install -y -qq zstd > /dev/null 2>&1
      zstd -3 --rm /work/$img.ext4 -o /work/$img.ext4.zst
    "

  SIZE=$(du -h "$ZST_PATH" | cut -f1)
  echo ">>> [$img] Compressed: $SIZE"

  echo ">>> [$img] Uploading to s3://$S3_BUCKET/$VERSION/$img.ext4.zst..."
  aws s3 cp "$ZST_PATH" "s3://$S3_BUCKET/$VERSION/$img.ext4.zst"

  # Clean up to save disk space
  rm -f "$ZST_PATH"

  echo ">>> [$img] Done."
  echo ""
done

echo "=== All rootfs images uploaded to s3://$S3_BUCKET/$VERSION/ ==="
aws s3 ls "s3://$S3_BUCKET/$VERSION/"
