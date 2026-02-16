#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Build Firecracker rootfs images for each supported language
# ---------------------------------------------------------------------------
# Creates minimal ext4 filesystem images with language runtimes and a
# guest agent for vsock communication.
#
# Each image includes:
#   - Base Ubuntu minimal userland
#   - Language runtime (Node.js, Python, etc.)
#   - Git (for cloning repos)
#   - Guest vsock agent (listens on vsock port 5000)
#   - "agent" user (uid 1001) for running untrusted code
#
# Images are placed in /var/lib/firecracker/rootfs/
# ---------------------------------------------------------------------------
set -euo pipefail

ROOTFS_DIR="/var/lib/firecracker/rootfs"
MOUNT_DIR="/tmp/fc-rootfs-mount"
IMAGE_SIZE_MB=4096

mkdir -p "$ROOTFS_DIR" "$MOUNT_DIR"

# ---------------------------------------------------------------------------
# Helper: create a base rootfs with Ubuntu minimal
# ---------------------------------------------------------------------------
create_base_rootfs() {
  local image_path="$1"
  local image_name="$2"

  echo "  Creating base filesystem for $image_name ($IMAGE_SIZE_MB MB)..."

  # Create empty ext4 image
  dd if=/dev/zero of="$image_path" bs=1M count=$IMAGE_SIZE_MB status=none
  mkfs.ext4 -q -F "$image_path"

  # Mount and bootstrap
  mount -o loop "$image_path" "$MOUNT_DIR"
  trap "umount '$MOUNT_DIR' 2>/dev/null || true" RETURN

  # Bootstrap minimal Ubuntu
  debootstrap --variant=minbase jammy "$MOUNT_DIR" http://archive.ubuntu.com/ubuntu

  # Essential packages
  chroot "$MOUNT_DIR" apt-get update -qq
  chroot "$MOUNT_DIR" apt-get install -y -qq \
    curl \
    ca-certificates \
    git \
    openssh-server \
    file \
    procps \
    sudo

  # Create unprivileged "agent" user for running workspace code
  chroot "$MOUNT_DIR" useradd -m -s /bin/bash -u 1001 agent
  chroot "$MOUNT_DIR" mkdir -p /workspace
  chroot "$MOUNT_DIR" chown agent:agent /workspace

  # Configure SSH (fallback if vsock is disabled)
  chroot "$MOUNT_DIR" mkdir -p /root/.ssh
  chmod 700 "$MOUNT_DIR/root/.ssh"

  # Minimal init: start guest agent on boot
  cat > "$MOUNT_DIR/etc/init.d/guest-agent" <<'INITEOF'
#!/bin/sh
### BEGIN INIT INFO
# Provides:          guest-agent
# Required-Start:    $local_fs
# Default-Start:     2 3 4 5
# Short-Description: ArcAgent guest vsock agent
### END INIT INFO
case "$1" in
  start)
    /usr/local/bin/guest-agent &
    ;;
  stop)
    killall guest-agent 2>/dev/null
    ;;
esac
INITEOF
  chmod 755 "$MOUNT_DIR/etc/init.d/guest-agent"

  # Install the guest agent binary
  # The guest agent is a simple program that:
  #   1. Listens on vsock port 5000
  #   2. Accepts JSON-framed requests: { "type": "exec"|"write_file", ... }
  #   3. Executes commands or writes files, returns JSON results
  #
  # For now, create a placeholder. The real binary should be built separately
  # and placed at /usr/local/bin/guest-agent in the rootfs.
  cat > "$MOUNT_DIR/usr/local/bin/guest-agent" <<'AGENTEOF'
#!/usr/bin/env bash
# Placeholder guest agent — replace with compiled binary
# This shell version handles basic exec requests over vsock
echo "guest-agent: starting on vsock port 5000" >&2

# The real guest agent should be a compiled Go/Rust binary that:
# - Listens on vsock CID=3 port 5000
# - Accepts 4-byte BE length-prefixed JSON frames
# - Handles: exec (run shell commands), write_file (write content to path)
# - Returns 4-byte BE length-prefixed JSON responses
# - Supports running commands as different users (su -c)
echo "guest-agent: placeholder — replace with compiled binary" >&2
sleep infinity
AGENTEOF
  chmod 755 "$MOUNT_DIR/usr/local/bin/guest-agent"

  # Network configuration (static IP assigned via kernel boot args)
  cat > "$MOUNT_DIR/etc/resolv.conf" <<'DNSEOF'
nameserver 8.8.8.8
nameserver 8.8.4.4
DNSEOF

  umount "$MOUNT_DIR"
  trap - RETURN

  echo "  Base rootfs created: $image_path"
}

# ---------------------------------------------------------------------------
# Helper: install language runtime into an existing rootfs
# ---------------------------------------------------------------------------
install_language() {
  local image_path="$1"
  local language="$2"

  mount -o loop "$image_path" "$MOUNT_DIR"
  trap "umount '$MOUNT_DIR' 2>/dev/null || true" RETURN

  case "$language" in
    node-20)
      echo "  Installing Node.js 20 LTS..."
      chroot "$MOUNT_DIR" bash -c 'curl -fsSL https://deb.nodesource.com/setup_20.x | bash -'
      chroot "$MOUNT_DIR" apt-get install -y -qq nodejs
      ;;
    python-312)
      echo "  Installing Python 3.12..."
      chroot "$MOUNT_DIR" apt-get install -y -qq software-properties-common
      chroot "$MOUNT_DIR" add-apt-repository -y ppa:deadsnakes/ppa
      chroot "$MOUNT_DIR" apt-get update -qq
      chroot "$MOUNT_DIR" apt-get install -y -qq python3.12 python3.12-venv python3-pip
      ;;
    rust-stable)
      echo "  Installing Rust stable..."
      chroot "$MOUNT_DIR" bash -c 'curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable'
      ;;
    go-122)
      echo "  Installing Go 1.22..."
      chroot "$MOUNT_DIR" bash -c 'curl -fsSL https://go.dev/dl/go1.22.0.linux-amd64.tar.gz | tar -C /usr/local -xzf -'
      chroot "$MOUNT_DIR" bash -c 'echo "export PATH=\$PATH:/usr/local/go/bin" >> /etc/profile.d/go.sh'
      ;;
    java-21)
      echo "  Installing Java 21..."
      chroot "$MOUNT_DIR" apt-get install -y -qq openjdk-21-jdk maven gradle
      ;;
    base)
      echo "  Base image — no additional language runtime."
      ;;
    *)
      echo "  WARNING: Unknown language '$language' — skipping runtime install."
      ;;
  esac

  # Clean up apt cache to reduce image size
  chroot "$MOUNT_DIR" apt-get clean
  chroot "$MOUNT_DIR" rm -rf /var/lib/apt/lists/*

  umount "$MOUNT_DIR"
  trap - RETURN
}

# ---------------------------------------------------------------------------
# Build each language image
# ---------------------------------------------------------------------------

# Map of image name → language installer
declare -A IMAGES=(
  ["node-20.ext4"]="node-20"
  ["python-312.ext4"]="python-312"
  ["rust-stable.ext4"]="rust-stable"
  ["go-122.ext4"]="go-122"
  ["java-21.ext4"]="java-21"
  ["base.ext4"]="base"
)

for image_name in "${!IMAGES[@]}"; do
  image_path="$ROOTFS_DIR/$image_name"

  if [ -f "$image_path" ]; then
    echo "Skipping $image_name (already exists)"
    continue
  fi

  echo "Building $image_name..."
  create_base_rootfs "$image_path" "$image_name"
  install_language "$image_path" "${IMAGES[$image_name]}"
  chown arcagent:arcagent "$image_path"
  echo "Done: $image_name ($(du -h "$image_path" | cut -f1))"
done

echo "All rootfs images built in $ROOTFS_DIR:"
ls -lh "$ROOTFS_DIR/"
