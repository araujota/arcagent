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
#   - "agent" user (uid 1000) for running untrusted code
#
# Images are placed in /var/lib/firecracker/rootfs/
# ---------------------------------------------------------------------------
set -euo pipefail

ROOTFS_DIR="/var/lib/firecracker/rootfs"
MOUNT_DIR="/tmp/fc-rootfs-mount"
IMAGE_SIZE_MB=4096
VSOCK_AGENT_BIN="${VSOCK_AGENT_BIN:-/opt/arcagent/scripts/vsock-agent}"
MIN_VSOCK_AGENT_BYTES="${MIN_VSOCK_AGENT_BYTES:-32768}"

mkdir -p "$ROOTFS_DIR" "$MOUNT_DIR"

if [ ! -x "$VSOCK_AGENT_BIN" ]; then
  echo "ERROR: Missing required vsock agent binary: $VSOCK_AGENT_BIN"
  echo "Refusing to build rootfs without a real vsock-agent binary."
  exit 1
fi

if [ ! -s "$VSOCK_AGENT_BIN" ] || [ "$(stat -c%s "$VSOCK_AGENT_BIN")" -lt "$MIN_VSOCK_AGENT_BYTES" ]; then
  echo "ERROR: vsock-agent binary at $VSOCK_AGENT_BIN is too small or empty."
  exit 1
fi

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
  chroot "$MOUNT_DIR" useradd -m -s /bin/bash -u 1000 -U agent
  chroot "$MOUNT_DIR" mkdir -p /workspace
  chroot "$MOUNT_DIR" chown agent:agent /workspace
  chroot "$MOUNT_DIR" chmod 0755 /workspace
  chroot "$MOUNT_DIR" gpasswd -d agent sudo >/dev/null 2>&1 || true

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
    /usr/local/bin/vsock-agent &
    ;;
  stop)
    killall vsock-agent 2>/dev/null
    ;;
esac
INITEOF
  chmod 755 "$MOUNT_DIR/etc/init.d/guest-agent"

  # Install real vsock-agent binary (and compatibility symlink).
  install -m 0755 "$VSOCK_AGENT_BIN" "$MOUNT_DIR/usr/local/bin/vsock-agent"
  ln -sf /usr/local/bin/vsock-agent "$MOUNT_DIR/usr/local/bin/guest-agent"

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
      # pip lives in "universe" on Ubuntu; enable it before installing Python tooling.
      chroot "$MOUNT_DIR" add-apt-repository -y universe
      chroot "$MOUNT_DIR" add-apt-repository -y ppa:deadsnakes/ppa
      chroot "$MOUNT_DIR" apt-get update -qq
      chroot "$MOUNT_DIR" apt-get install -y -qq python3.12 python3.12-venv python3-pip || \
        chroot "$MOUNT_DIR" apt-get install -y -qq python3.12 python3.12-venv
      chroot "$MOUNT_DIR" bash -lc 'python3.12 -m ensurepip --upgrade || true'
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
      chroot "$MOUNT_DIR" apt-get update -qq
      chroot "$MOUNT_DIR" add-apt-repository -y universe
      chroot "$MOUNT_DIR" apt-get update -qq
      chroot "$MOUNT_DIR" apt-get install -y -qq curl ca-certificates tar maven gradle
      chroot "$MOUNT_DIR" bash -lc '
        set -e
        mkdir -p /opt/java-21
        curl -fsSL "https://api.adoptium.net/v3/binary/latest/21/ga/linux/x64/jdk/hotspot/normal/eclipse?project=jdk" \
          | tar -xzf - --strip-components=1 -C /opt/java-21
        ln -sf /opt/java-21/bin/java /usr/local/bin/java
        ln -sf /opt/java-21/bin/javac /usr/local/bin/javac
      '
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

validate_rootfs_image() {
  local image_path="$1"
  local stat_out
  if ! stat_out=$(debugfs -R "stat /usr/local/bin/vsock-agent" "$image_path" 2>/dev/null); then
    echo "ERROR: Rootfs validation failed for $image_path: /usr/local/bin/vsock-agent missing"
    return 1
  fi
  local size
  size=$(echo "$stat_out" | sed -n 's/.*Size:[[:space:]]*\([0-9]\+\).*/\1/p' | head -1)
  if [ -z "$size" ] || [ "$size" -lt "$MIN_VSOCK_AGENT_BYTES" ]; then
    echo "ERROR: Rootfs validation failed for $image_path: vsock-agent size $size < $MIN_VSOCK_AGENT_BYTES"
    return 1
  fi

  local passwd_out
  passwd_out="$(debugfs -R "cat /etc/passwd" "$image_path" 2>/dev/null || true)"
  if ! echo "$passwd_out" | grep -q '^agent:x:1000:1000:'; then
    echo "ERROR: Rootfs validation failed for $image_path: missing agent user (uid/gid 1000)"
    return 1
  fi

  local workspace_stat workspace_uid workspace_gid
  if ! workspace_stat=$(debugfs -R "stat /workspace" "$image_path" 2>/dev/null); then
    echo "ERROR: Rootfs validation failed for $image_path: /workspace missing"
    return 1
  fi
  workspace_uid="$(echo "$workspace_stat" | sed -n 's/.*User:[[:space:]]*\([0-9]\+\).*/\1/p' | head -1)"
  workspace_gid="$(echo "$workspace_stat" | sed -n 's/.*Group:[[:space:]]*\([0-9]\+\).*/\1/p' | head -1)"
  if [ "$workspace_uid" != "1000" ] || [ "$workspace_gid" != "1000" ]; then
    echo "ERROR: Rootfs validation failed for $image_path: /workspace ownership is ${workspace_uid}:${workspace_gid}, expected 1000:1000"
    return 1
  fi
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
  validate_rootfs_image "$image_path"
  chown arcagent:arcagent "$image_path"
  echo "Done: $image_name ($(du -h "$image_path" | cut -f1))"
done

echo "All rootfs images built in $ROOTFS_DIR:"
ls -lh "$ROOTFS_DIR/"
