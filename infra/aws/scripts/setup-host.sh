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
ROOTFS_BUCKET="${rootfs_bucket}"
ROOTFS_VERSION="${rootfs_version}"
ROOTFS_UPLOAD_ON_BOOT="${rootfs_upload_on_boot}"
AWS_REGION="${aws_region}"
WORKER_ARTIFACT_S3_KEY="${worker_artifact_s3_key}"
ENABLE_SONARQUBE="${enable_sonarqube}"
SONARQUBE_URL="${sonarqube_url}"
SONARQUBE_TOKEN="${sonarqube_token}"
SNYK_TOKEN="${snyk_token}"

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
# Pre-seed iptables-persistent to avoid interactive prompts
echo iptables-persistent iptables-persistent/autosave_v4 boolean true | debconf-set-selections
echo iptables-persistent iptables-persistent/autosave_v6 boolean true | debconf-set-selections

apt-get install -y -qq \
  build-essential \
  curl \
  git \
  jq \
  iptables \
  iptables-persistent \
  iproute2 \
  redis-server \
  squid-openssl \
  dmsetup \
  cryptsetup \
  file \
  acl \
  unzip \
  awscli \
  zstd \
  debootstrap \
  docker.io \
  docker-compose-plugin

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

# Persist iptables rules (restored on reboot by iptables-persistent / netfilter-persistent)
mkdir -p /etc/iptables
iptables-save > /etc/iptables/rules.v4
systemctl enable netfilter-persistent 2>/dev/null || true

# ---------------------------------------------------------------------------
# 4. Firecracker install is executed after script sync in step 8
# ---------------------------------------------------------------------------
echo ">>> Firecracker install deferred until provisioning scripts are synced."

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
# 6. Configure container runtime sidecars (Redis + optional SonarQube)
# ---------------------------------------------------------------------------
echo ">>> Configuring runtime sidecars..."
systemctl enable docker
systemctl start docker

mkdir -p /opt/arcagent/runtime
cat > /opt/arcagent/runtime/docker-compose.yml <<'COMPOSEEOF'
services:
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis-data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5
    restart: unless-stopped

  sonarqube-db:
    image: postgres:15-alpine
    environment:
      POSTGRES_USER: sonarqube
      POSTGRES_PASSWORD: sonarqube
      POSTGRES_DB: sonarqube
    volumes:
      - sonarqube-db-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U sonarqube -d sonarqube"]
      interval: 10s
      timeout: 5s
      retries: 5
    restart: unless-stopped

  sonarqube:
    image: sonarqube:community
    ports:
      - "9000:9000"
    environment:
      SONAR_JDBC_URL: jdbc:postgresql://sonarqube-db:5432/sonarqube
      SONAR_JDBC_USERNAME: sonarqube
      SONAR_JDBC_PASSWORD: sonarqube
    depends_on:
      sonarqube-db:
        condition: service_healthy
    healthcheck:
      test: ["CMD-SHELL", "curl -f http://localhost:9000/api/system/status | grep -q UP"]
      interval: 30s
      timeout: 10s
      retries: 10
      start_period: 120s
    restart: unless-stopped

volumes:
  redis-data:
  sonarqube-db-data:
COMPOSEEOF

cat > /etc/systemd/system/arcagent-runtime-stack.service <<'SERVICEEOF'
[Unit]
Description=ArcAgent runtime sidecars (Redis/SonarQube)
After=network-online.target docker.service
Wants=network-online.target docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/arcagent/runtime
ExecStart=/usr/bin/docker compose -f /opt/arcagent/runtime/docker-compose.yml up -d
ExecStop=/usr/bin/docker compose -f /opt/arcagent/runtime/docker-compose.yml down
TimeoutStartSec=300
TimeoutStopSec=120

[Install]
WantedBy=multi-user.target
SERVICEEOF

systemctl daemon-reload
systemctl enable arcagent-runtime-stack
systemctl start arcagent-runtime-stack

/usr/bin/docker compose -f /opt/arcagent/runtime/docker-compose.yml up -d redis
/usr/bin/docker compose -f /opt/arcagent/runtime/docker-compose.yml ps redis
if [ "$ENABLE_SONARQUBE" = "true" ]; then
  /usr/bin/docker compose -f /opt/arcagent/runtime/docker-compose.yml up -d sonarqube-db sonarqube
fi

# ---------------------------------------------------------------------------
# 7. Create worker user and directories
# ---------------------------------------------------------------------------
echo ">>> Setting up worker user and directories..."

# Create arcagent user (no fixed UID — UID 1000 is typically taken by 'ubuntu')
if ! id -u arcagent &>/dev/null; then
  useradd -m -s /bin/bash arcagent
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
SCRIPT_NAMES=(setup-worker.sh install-firecracker.sh detect-host-url.sh build-rootfs.sh)
for script in "$${SCRIPT_NAMES[@]}"; do
  if aws s3 cp "s3://$ROOTFS_BUCKET/scripts/$${script}" "/opt/arcagent/scripts/$${script}" --region "$AWS_REGION" --quiet; then
    chmod 755 "/opt/arcagent/scripts/$${script}"
  else
    echo "ERROR: Missing provisioning script s3://$ROOTFS_BUCKET/scripts/$${script}"
    exit 1
  fi
done
chown -R root:root /opt/arcagent/scripts
echo "Provisioning scripts downloaded to /opt/arcagent/scripts."

# Install Firecracker + Jailer once install-firecracker.sh is available.
echo ">>> Installing Firecracker v$FIRECRACKER_VERSION..."
bash /opt/arcagent/scripts/install-firecracker.sh "$FIRECRACKER_VERSION"

# Optional: deploy worker build artifact from S3
if [ -n "$WORKER_ARTIFACT_S3_KEY" ]; then
  echo ">>> Downloading worker artifact s3://$ROOTFS_BUCKET/$WORKER_ARTIFACT_S3_KEY..."
  mkdir -p /opt/arcagent/worker
  if aws s3 cp "s3://$ROOTFS_BUCKET/$WORKER_ARTIFACT_S3_KEY" /tmp/worker-build.tar.gz --region "$AWS_REGION"; then
    tar -xzf /tmp/worker-build.tar.gz -C /opt/arcagent/worker
    chown -R arcagent:arcagent /opt/arcagent/worker
    rm -f /tmp/worker-build.tar.gz
    if [ -f /opt/arcagent/worker/package-lock.json ]; then
      echo "Installing worker runtime dependencies..."
      cd /opt/arcagent/worker
      npm ci --omit=dev
    fi
  else
    echo "WARNING: Failed to download worker artifact from S3 key '$WORKER_ARTIFACT_S3_KEY'."
  fi
else
  echo "No worker artifact key configured (worker_artifact_s3_key)."
fi

# ---------------------------------------------------------------------------
# 9. Download pre-built rootfs images from S3
# ---------------------------------------------------------------------------
echo ">>> Downloading pre-built rootfs images from s3://$ROOTFS_BUCKET/$ROOTFS_VERSION/..."
ROOTFS_IMAGES=(base node-20 python-312 rust-stable go-122 java-21)
ROOTFS_DOWNLOAD_FAILED=false
BUILT_ROOTFS_IMAGES=()

for img in "$${ROOTFS_IMAGES[@]}"; do
  dest="/var/lib/firecracker/rootfs/$${img}.ext4"
  if [ -f "$dest" ]; then
    echo "  $${img}.ext4 already exists — skipping"
    continue
  fi

  echo "  Downloading $${img}.ext4.zst..."
  if aws s3 cp "s3://$ROOTFS_BUCKET/$ROOTFS_VERSION/$${img}.ext4.zst" "/tmp/$${img}.ext4.zst" \
       --region "$AWS_REGION" --quiet; then
    echo "  Decompressing $${img}.ext4.zst..."
    zstd -d --rm "/tmp/$${img}.ext4.zst" -o "$dest"
    chown arcagent:arcagent "$dest"
    echo "  Done: $${img}.ext4 ($(du -h "$dest" | cut -f1))"
  else
    echo "  WARNING: Failed to download $${img}.ext4.zst from S3"
    ROOTFS_DOWNLOAD_FAILED=true
  fi
done

if [ "$ROOTFS_DOWNLOAD_FAILED" = "true" ]; then
  echo "WARNING: Some rootfs images failed to download."
  echo "Falling back to local build if build-rootfs.sh is available..."
  if [ -f /opt/arcagent/scripts/build-rootfs.sh ]; then
    bash /opt/arcagent/scripts/build-rootfs.sh
    for img in "$${ROOTFS_IMAGES[@]}"; do
      if [ -f "/var/lib/firecracker/rootfs/$${img}.ext4" ]; then
        BUILT_ROOTFS_IMAGES+=("$${img}")
      fi
    done
  else
    echo "ERROR: No rootfs images available and no build script found."
    echo "Upload images to S3 first: bash infra/rootfs/build-and-upload.sh $ROOTFS_BUCKET $ROOTFS_VERSION"
  fi
fi

if [ "$ROOTFS_UPLOAD_ON_BOOT" = "true" ] && [ "$${#BUILT_ROOTFS_IMAGES[@]}" -gt 0 ]; then
  echo ">>> Uploading locally-built rootfs images to s3://$ROOTFS_BUCKET/$ROOTFS_VERSION/ ..."
  for img in "$${BUILT_ROOTFS_IMAGES[@]}"; do
    ext4_path="/var/lib/firecracker/rootfs/$${img}.ext4"
    s3_key="$ROOTFS_VERSION/$${img}.ext4.zst"

    if aws s3api head-object --bucket "$ROOTFS_BUCKET" --key "$s3_key" --region "$AWS_REGION" >/dev/null 2>&1; then
      echo "  $${img}.ext4.zst already exists in S3 - skipping upload"
      continue
    fi

    tmp_zst="/tmp/$${img}.ext4.zst"
    echo "  Compressing $ext4_path ..."
    zstd -3 -f "$ext4_path" -o "$tmp_zst"

    echo "  Uploading s3://$ROOTFS_BUCKET/$s3_key ..."
    aws s3 cp "$tmp_zst" "s3://$ROOTFS_BUCKET/$s3_key" --region "$AWS_REGION"
    rm -f "$tmp_zst"
  done
fi

echo "Rootfs images in /var/lib/firecracker/rootfs/:"
ls -lh /var/lib/firecracker/rootfs/ 2>/dev/null || echo "  (empty)"

# ---------------------------------------------------------------------------
# 10. Download vmlinux kernel
# ---------------------------------------------------------------------------
echo ">>> Downloading Firecracker kernel..."
KERNEL_PATH="/var/lib/firecracker/vmlinux"
if [ ! -f "$KERNEL_PATH" ]; then
  # Kernels are hosted in the Firecracker CI S3 bucket, not in GitHub releases.
  # Use the major.minor version to find the right CI prefix (e.g. 1.10.1 → v1.10).
  FC_MAJOR_MINOR=$(echo "$FIRECRACKER_VERSION" | cut -d. -f1,2)
  KERNEL_URL="https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v$${FC_MAJOR_MINOR}/x86_64/vmlinux-6.1.102"
  echo "  Kernel URL: $KERNEL_URL"
  curl -fsSL -o "$KERNEL_PATH" "$KERNEL_URL" || {
    echo "WARNING: Could not download kernel from CI bucket. Trying 5.10 series..."
    curl -fsSL -o "$KERNEL_PATH" \
      "https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v$${FC_MAJOR_MINOR}/x86_64/vmlinux-5.10.223" || {
      echo "ERROR: Failed to download vmlinux kernel. Provide it manually at $KERNEL_PATH"
    }
  }
  [ -f "$KERNEL_PATH" ] && chown arcagent:arcagent "$KERNEL_PATH"
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
FC_JAILER_UID=$(id -u arcagent)
FC_JAILER_GID=$(id -g arcagent)

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

if [ -n "$SNYK_TOKEN" ]; then
  echo "SNYK_TOKEN=$SNYK_TOKEN" >> /opt/arcagent/worker.env
fi
if [ -n "$SONARQUBE_URL" ]; then
  echo "SONARQUBE_URL=$SONARQUBE_URL" >> /opt/arcagent/worker.env
fi
if [ -n "$SONARQUBE_TOKEN" ]; then
  echo "SONARQUBE_TOKEN=$SONARQUBE_TOKEN" >> /opt/arcagent/worker.env
fi

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
