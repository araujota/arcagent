#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# ArcAgent Worker — Host Setup (runs as user-data on first boot)
# ---------------------------------------------------------------------------
# Installs all dependencies, configures the host for Firecracker microVMs,
# and starts the worker service via systemd.
#
# This script is idempotent — safe to re-run.
# ---------------------------------------------------------------------------
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

LOG_FILE="/var/log/arcagent-setup.log"
exec > >(tee -a "$LOG_FILE") 2>&1
echo "=== ArcAgent worker setup started at $(date -u) ==="

# ---------------------------------------------------------------------------
# Template variables (injected by Terraform)
# ---------------------------------------------------------------------------
ENVIRONMENT="${environment}"
WORKER_SHARED_SECRET="${worker_shared_secret}"
CONVEX_URL="${convex_url}"
MAX_DEV_VMS="${max_dev_vms}"
WARM_POOL_SIZE="${warm_pool_size}"
MAX_WARM_VMS="${max_warm_vms}"
FIRECRACKER_VERSION="${firecracker_version}"
NODE_VERSION="${node_version}"
HARDEN_EGRESS="${harden_egress}"
WORKER_CONCURRENCY="${worker_concurrency}"
WORKSPACE_IDLE_TIMEOUT_MS="${workspace_idle_timeout_ms}"

# Auto-detect public IP via IMDSv2 (EIP isn't known at user-data render time)
echo ">>> Detecting public IP via IMDSv2..."
IMDS_TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" \
  -H "X-aws-ec2-metadata-token-ttl-seconds: 60")
PUBLIC_IP=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" \
  "http://169.254.169.254/latest/meta-data/public-ipv4" || echo "")

if [ -z "$PUBLIC_IP" ]; then
  echo "WARNING: Could not detect public IP. WORKER_HOST_URL will use localhost."
  echo "You must set WORKER_HOST_URL manually in /opt/arcagent/worker.env after EIP assignment."
  WORKER_HOST_URL="http://localhost:3001"
else
  WORKER_HOST_URL="http://$PUBLIC_IP:3001"
  echo "Detected public IP: $PUBLIC_IP"
fi

# ---------------------------------------------------------------------------
# 1. System packages
# ---------------------------------------------------------------------------
echo ">>> Installing system packages..."
apt-get update -qq
apt-get install -y -qq \
  build-essential \
  curl \
  git \
  jq \
  iptables \
  iproute2 \
  redis-server \
  squid-openssl \
  dmsetup \
  cryptsetup \
  file \
  acl \
  unzip

# ---------------------------------------------------------------------------
# 2. Enable KVM
# ---------------------------------------------------------------------------
echo ">>> Configuring KVM..."
if [ ! -e /dev/kvm ]; then
  echo "WARNING: /dev/kvm not found. This instance may not support KVM."
  echo "Firecracker requires a .metal instance type."
fi

# Ensure kvm group exists and the worker user can access it
groupadd -f kvm
chmod 666 /dev/kvm 2>/dev/null || true

# ---------------------------------------------------------------------------
# 3. Enable IP forwarding (required for Firecracker TAP networking)
# ---------------------------------------------------------------------------
echo ">>> Enabling IP forwarding..."
sysctl -w net.ipv4.ip_forward=1
if ! grep -q "net.ipv4.ip_forward=1" /etc/sysctl.conf; then
  echo "net.ipv4.ip_forward=1" >> /etc/sysctl.conf
fi

# Enable NAT masquerading for VM outbound traffic
# VMs use 10.0.0.0/24 internally — NAT to the host's interface
PRIMARY_IF=$(ip route show default | awk '/default/ {print $5}' | head -1)
iptables -t nat -C POSTROUTING -o "$PRIMARY_IF" -s 10.0.0.0/24 -j MASQUERADE 2>/dev/null || \
  iptables -t nat -A POSTROUTING -o "$PRIMARY_IF" -s 10.0.0.0/24 -j MASQUERADE

# Persist iptables rules
mkdir -p /etc/iptables
iptables-save > /etc/iptables/rules.v4

# ---------------------------------------------------------------------------
# 4. Install Firecracker + Jailer
# ---------------------------------------------------------------------------
echo ">>> Installing Firecracker v$FIRECRACKER_VERSION..."
if [ -f /opt/arcagent/scripts/install-firecracker.sh ]; then
  bash /opt/arcagent/scripts/install-firecracker.sh "$FIRECRACKER_VERSION"
else
  echo "Skipping — install-firecracker.sh not yet deployed."
fi

# ---------------------------------------------------------------------------
# 5. Install Node.js
# ---------------------------------------------------------------------------
echo ">>> Installing Node.js v$NODE_VERSION..."
if ! command -v node &>/dev/null; then
  curl -fsSL "https://deb.nodesource.com/setup_$NODE_VERSION.x" | bash -
  apt-get install -y -qq nodejs
fi
echo "Node.js: $(node --version)"

# ---------------------------------------------------------------------------
# 6. Configure Redis (local, no auth needed — only localhost access)
# ---------------------------------------------------------------------------
echo ">>> Configuring Redis..."
systemctl enable redis-server
systemctl start redis-server

# Verify Redis is running
redis-cli ping || { echo "ERROR: Redis not responding"; exit 1; }

# ---------------------------------------------------------------------------
# 7. Create worker user and directories
# ---------------------------------------------------------------------------
echo ">>> Setting up worker user and directories..."

# Create arcagent user (UID 1000 matches jailer expectation)
if ! id -u arcagent &>/dev/null; then
  useradd -m -s /bin/bash -u 1000 arcagent
fi
usermod -aG kvm arcagent 2>/dev/null || true

# Firecracker directories
mkdir -p /var/lib/firecracker/rootfs
mkdir -p /var/lib/firecracker/kernel
chown -R arcagent:arcagent /var/lib/firecracker

# Worker application directory
mkdir -p /opt/arcagent
chown -R arcagent:arcagent /opt/arcagent

# ---------------------------------------------------------------------------
# 8. Deploy provisioning scripts from repo (or pre-baked AMI)
# ---------------------------------------------------------------------------
echo ">>> Deploying provisioning scripts..."
mkdir -p /opt/arcagent/scripts

# If scripts aren't already on disk (e.g. custom AMI), download from release
# For now, check if they exist from a prior run or AMI bake
if [ ! -f /opt/arcagent/scripts/install-firecracker.sh ]; then
  echo "WARNING: Provisioning scripts not found at /opt/arcagent/scripts/."
  echo "You need to copy infra/aws/scripts/* to /opt/arcagent/scripts/ on the host."
  echo "This is typically done via:"
  echo "  1. Baking a custom AMI with packer"
  echo "  2. Or: scp infra/aws/scripts/* ubuntu@<host>:/opt/arcagent/scripts/"
  echo "  3. Then re-run this script: sudo bash /var/lib/cloud/instance/user-data.txt"
  echo ""
  echo "Skipping Firecracker install and rootfs build for now."
  SKIP_FIRECRACKER=true
else
  SKIP_FIRECRACKER=false
fi

# ---------------------------------------------------------------------------
# 9. Install Firecracker + build rootfs (if scripts available)
# ---------------------------------------------------------------------------
if [ "$SKIP_FIRECRACKER" = "false" ]; then
  echo ">>> Building rootfs images..."
  bash /opt/arcagent/scripts/build-rootfs.sh
fi

# ---------------------------------------------------------------------------
# 10. Download vmlinux kernel
# ---------------------------------------------------------------------------
echo ">>> Downloading Firecracker kernel..."
KERNEL_PATH="/var/lib/firecracker/vmlinux"
if [ ! -f "$KERNEL_PATH" ]; then
  KERNEL_URL="https://github.com/firecracker-microvm/firecracker/releases/download/v$FIRECRACKER_VERSION/vmlinux-5.10-x86_64.bin"
  curl -fsSL -o "$KERNEL_PATH" "$KERNEL_URL" || {
    # Fallback: try the generic kernel from the release assets
    echo "Direct kernel download failed, trying release assets..."
    FC_RELEASE="https://github.com/firecracker-microvm/firecracker/releases/download/v$FIRECRACKER_VERSION"
    curl -fsSL -o /tmp/fc-kernel.tar.gz "$FC_RELEASE/firecracker-v$FIRECRACKER_VERSION-x86_64.tgz"
    tar -xzf /tmp/fc-kernel.tar.gz -C /tmp
    cp /tmp/release-v*/vmlinux* "$KERNEL_PATH" 2>/dev/null || \
      echo "WARNING: Could not find vmlinux in release archive. You may need to provide it manually."
    rm -rf /tmp/fc-kernel.tar.gz /tmp/release-v*
  }
  chown arcagent:arcagent "$KERNEL_PATH"
fi

# ---------------------------------------------------------------------------
# 11. Configure Squid (for hardened egress, if enabled)
# ---------------------------------------------------------------------------
if [ "$HARDEN_EGRESS" = "true" ]; then
  echo ">>> Configuring Squid for egress filtering..."
  mkdir -p /etc/squid/ssl_cert
  # Generate a self-signed CA for SSL bumping (VMs trust this CA)
  if [ ! -f /etc/squid/ssl_cert/myCA.pem ]; then
    openssl req -new -newkey rsa:2048 -days 3650 -nodes -x509 \
      -subj "/C=US/ST=CA/O=ArcAgent/CN=ArcAgent Egress CA" \
      -keyout /etc/squid/ssl_cert/myCA.key \
      -out /etc/squid/ssl_cert/myCA.pem
    cat /etc/squid/ssl_cert/myCA.key /etc/squid/ssl_cert/myCA.pem > /etc/squid/ssl_cert/myCA-combined.pem
    chown proxy:proxy /etc/squid/ssl_cert/*
    chmod 600 /etc/squid/ssl_cert/myCA.key
  fi
fi

# ---------------------------------------------------------------------------
# 12. Write worker environment file
# ---------------------------------------------------------------------------
echo ">>> Writing worker environment config..."
cat > /opt/arcagent/worker.env <<ENVEOF
# ArcAgent Worker Environment — managed by Terraform
# -------------------------------------------------------
# Required (worker won't function without these)
# -------------------------------------------------------
PORT=3001
REDIS_URL=redis://127.0.0.1:6379
WORKER_SHARED_SECRET=$WORKER_SHARED_SECRET
CONVEX_URL=$CONVEX_URL

# WORKER_HOST_URL is auto-detected on each service start via ExecStartPre.
# The EIP may not be attached during initial user-data run, so the pre-start
# script re-detects the public IP from IMDSv2 before every worker launch.
WORKER_HOST_URL=$WORKER_HOST_URL

# -------------------------------------------------------
# VM capacity
# -------------------------------------------------------
MAX_DEV_VMS=$MAX_DEV_VMS
WARM_POOL_SIZE=$WARM_POOL_SIZE
MAX_WARM_VMS=$MAX_WARM_VMS
WORKER_CONCURRENCY=$WORKER_CONCURRENCY
WORKSPACE_IDLE_TIMEOUT_MS=$WORKSPACE_IDLE_TIMEOUT_MS

# -------------------------------------------------------
# Firecracker / VM configuration
# -------------------------------------------------------
FC_USE_VSOCK=true
FC_HARDEN_EGRESS=$HARDEN_EGRESS
FIRECRACKER_BIN=/usr/local/bin/firecracker
JAILER_BIN=/usr/local/bin/jailer
FC_KERNEL_IMAGE=/var/lib/firecracker/vmlinux
FC_ROOTFS_DIR=/var/lib/firecracker/rootfs

# -------------------------------------------------------
# Runtime
# -------------------------------------------------------
LOG_LEVEL=info
NODE_ENV=production

# -------------------------------------------------------
# Optional — scanning gates (uncomment to enable)
# -------------------------------------------------------
# SNYK_TOKEN=
# SONARQUBE_URL=
# SONARQUBE_TOKEN=
# GITHUB_TOKEN=
ENVEOF

chown arcagent:arcagent /opt/arcagent/worker.env
chmod 600 /opt/arcagent/worker.env

# ---------------------------------------------------------------------------
# 13. Set up worker systemd service
# ---------------------------------------------------------------------------
echo ">>> Configuring systemd service..."
bash /opt/arcagent/scripts/setup-worker.sh

# ---------------------------------------------------------------------------
# 14. Start the worker
# ---------------------------------------------------------------------------
echo ">>> Starting arcagent-worker service..."
systemctl daemon-reload
systemctl enable arcagent-worker
systemctl start arcagent-worker

# Verify it started
sleep 3
if systemctl is-active --quiet arcagent-worker; then
  echo "arcagent-worker is running."
else
  echo "ERROR: arcagent-worker failed to start. Check: journalctl -u arcagent-worker"
  systemctl status arcagent-worker --no-pager || true
fi

echo "=== ArcAgent worker setup completed at $(date -u) ==="
