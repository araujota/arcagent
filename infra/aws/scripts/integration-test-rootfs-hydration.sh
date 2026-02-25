#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Integration test: verify rootfs images can be hydrated from S3 into a host.
# ---------------------------------------------------------------------------
# This simulates the setup-host.sh download path for execution environments:
#   1) download *.ext4.zst from S3
#   2) decompress to ext4 image
#   3) validate ext4 filesystem signature
#
# Usage:
#   bash integration-test-rootfs-hydration.sh <bucket> [version] [region]
# Example:
#   bash integration-test-rootfs-hydration.sh arcagent-rootfs-123456789012-test v1 us-east-1
# ---------------------------------------------------------------------------
set -euo pipefail

ROOTFS_BUCKET="${1:?Usage: $0 <bucket> [version] [region]}"
ROOTFS_VERSION="${2:-v1}"
AWS_REGION="${3:-us-east-1}"

ROOTFS_IMAGES=(base node-20 python-312 rust-stable go-122 java-21)
TEST_ID="$(date +%s)"
TARGET_DIR="/var/lib/firecracker/rootfs-integration-$TEST_ID"
TMP_DIR="/tmp/rootfs-integration-$TEST_ID"

cleanup() {
  rm -rf "$TMP_DIR" "$TARGET_DIR"
}
trap cleanup EXIT

mkdir -p "$TARGET_DIR" "$TMP_DIR"

echo "=== Rootfs Hydration Integration Test ==="
echo "Bucket:  s3://$ROOTFS_BUCKET/$ROOTFS_VERSION/"
echo "Region:  $AWS_REGION"
echo "Target:  $TARGET_DIR"
echo

pass_count=0

for img in "${ROOTFS_IMAGES[@]}"; do
  zst_path="$TMP_DIR/${img}.ext4.zst"
  ext4_path="$TARGET_DIR/${img}.ext4"

  echo ">>> [$img] Downloading from S3..."
  aws s3 cp "s3://$ROOTFS_BUCKET/$ROOTFS_VERSION/${img}.ext4.zst" "$zst_path" --region "$AWS_REGION" --quiet

  echo ">>> [$img] Decompressing..."
  zstd -d --rm "$zst_path" -o "$ext4_path" >/dev/null

  if [ ! -s "$ext4_path" ]; then
    echo "FAIL: [$img] ext4 file is missing or empty"
    exit 1
  fi

  fs_sig="$(file -s "$ext4_path" || true)"
  if ! echo "$fs_sig" | grep -qi "ext[234] filesystem"; then
    echo "FAIL: [$img] not recognized as ext filesystem"
    echo "file -s output: $fs_sig"
    exit 1
  fi

  echo "PASS: [$img] hydrated successfully"
  pass_count=$((pass_count + 1))
done

echo
echo "All rootfs hydration checks passed ($pass_count/${#ROOTFS_IMAGES[@]})."
