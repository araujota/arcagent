#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# ArcAgent Worker — Host Setup (runs as user-data on first boot)
# ---------------------------------------------------------------------------
# Installs dependencies and starts the worker service via systemd.
# In API-only deployments, the worker provisions and owns workspace execution
# using the Firecracker backend.
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
CONVEX_HTTP_ACTIONS_URL="${convex_http_actions_url}"
WORKER_ROLE="${worker_role}"
MAX_DEV_VMS="${max_dev_vms}"
WARM_POOL_SIZE="${warm_pool_size}"
MAX_WARM_VMS="${max_warm_vms}"
NODE_VERSION="${node_version}"
WORKER_CONCURRENCY="${worker_concurrency}"
WORKSPACE_IDLE_TIMEOUT_MS="${workspace_idle_timeout_ms}"
ARTIFACT_BUCKET="${artifact_bucket}"
AWS_REGION="${aws_region}"
ROUTE53_ZONE_NAME="${route53_zone_name}"
WORKER_DNS_NAME="${worker_dns_name}"
WORKER_ARTIFACT_S3_KEY="${worker_artifact_s3_key}"
WORKER_PUBLIC_URL="${worker_public_url}"
ENABLE_SONARQUBE="${enable_sonarqube}"
SONARQUBE_URL="${sonarqube_url}"
SONARQUBE_TOKEN="${sonarqube_token}"
SNYK_TOKEN="${snyk_token}"

if [ "$WORKER_ROLE" != "api" ]; then
  echo "ERROR: Unsupported WORKER_ROLE '$WORKER_ROLE'. API-only deployment requires WORKER_ROLE=api."
  exit 1
fi

echo "Worker role: $WORKER_ROLE (execution_backend=firecracker)"

if [ -z "$CONVEX_HTTP_ACTIONS_URL" ]; then
  CONVEX_HTTP_ACTIONS_URL="$${CONVEX_URL/.convex.cloud/.convex.site}"
fi

WORKER_HOST_URL_LOCKED="false"
if [ -n "$WORKER_PUBLIC_URL" ]; then
  WORKER_HOST_URL="$WORKER_PUBLIC_URL"
  WORKER_HOST_URL_LOCKED="true"
  echo "Using fixed worker URL from Terraform: $WORKER_HOST_URL"
else
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
  file \
  acl \
  unzip \
  awscli \
  docker.io \
  python3 \
  python3-venv \
  python3-pip \
  golang-go \
  rustc \
  cargo \
  default-jdk \
  maven \
  gradle \
  ruby-full \
  php \
  php-cli \
  php-xml \
  php-mbstring \
  php-curl \
  php-zip \
  composer \
  cppcheck \
  clang-tidy \
  flawfinder

# Optional package on newer Ubuntu variants; skip silently if unavailable.
apt-get install -y -qq openjdk-21-jdk-headless || true

# Ubuntu package naming for Compose varies by repository/version.
# Prefer Docker Compose v2 plugin, fall back to docker-compose v1.
if ! apt-get install -y -qq docker-compose-plugin; then
  apt-get install -y -qq docker-compose
fi

# ---------------------------------------------------------------------------
# 2. Install Node.js
# ---------------------------------------------------------------------------
echo ">>> Installing Node.js v$NODE_VERSION..."
if ! command -v node &>/dev/null; then
  curl -fsSL "https://deb.nodesource.com/setup_$NODE_VERSION.x" | bash -
  apt-get install -y -qq nodejs
fi
echo "Node.js: $(node --version)"

# ---------------------------------------------------------------------------
# 3. Install cross-language toolchain/scanner CLIs for process backend parity
# ---------------------------------------------------------------------------
echo ">>> Installing process-backend toolchain/scanner dependencies..."

# Python tooling used by gates (best effort for transient install failures).
# Install into an isolated venv to avoid breaking distro python packages
# used by docker-compose on older Ubuntu images.
TOOLING_VENV="/opt/arcagent/tooling-venv"
python3 -m venv "$TOOLING_VENV" || true
"$TOOLING_VENV/bin/pip" install --upgrade pip setuptools wheel || true
"$TOOLING_VENV/bin/pip" install --upgrade ruff mypy bandit semgrep pytest || true
for tool in ruff mypy bandit semgrep pytest; do
  if [ -x "$TOOLING_VENV/bin/$tool" ]; then
    ln -sf "$TOOLING_VENV/bin/$tool" "/usr/local/bin/$tool"
  fi
done

# JS/TS tooling.
npm install -g pyright || true

# Go security/lint tooling.
GOBIN=/usr/local/bin go install github.com/securego/gosec/v2/cmd/gosec@latest || true
curl -sSfL https://raw.githubusercontent.com/golangci/golangci-lint/master/install.sh | sh -s -- -b /usr/local/bin || true

# Rust security tooling.
cargo install cargo-audit || true

# Vulnerability scanner used by security gate.
curl -sfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh | sh -s -- -b /usr/local/bin || true

# ---------------------------------------------------------------------------
# 4. Configure container runtime sidecars (Redis + optional SonarQube)
# ---------------------------------------------------------------------------
echo ">>> Configuring runtime sidecars..."
systemctl enable docker
systemctl start docker

# Use containerized Redis sidecar; disable host redis-server to avoid :6379 conflicts.
systemctl stop redis-server 2>/dev/null || true
systemctl disable redis-server 2>/dev/null || true

# Unified compose wrapper (supports both "docker compose" and "docker-compose").
cat > /usr/local/bin/arcagent-compose <<'COMPOSEWRAP'
#!/usr/bin/env bash
set -euo pipefail

if /usr/bin/docker compose version >/dev/null 2>&1; then
  exec /usr/bin/docker compose "$@"
fi

if command -v docker-compose >/dev/null 2>&1; then
  exec "$(command -v docker-compose)" "$@"
fi

echo "ERROR: Neither 'docker compose' nor 'docker-compose' is installed." >&2
exit 1
COMPOSEWRAP
chmod 755 /usr/local/bin/arcagent-compose

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
      POSTGRES_PASSWORD: $${SONARQUBE_DB_PASSWORD:-local_dev_sonarqube_db}
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
      SONAR_JDBC_PASSWORD: $${SONARQUBE_DB_PASSWORD:-local_dev_sonarqube_db}
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

RUNTIME_SERVICES="redis"
if [ "$ENABLE_SONARQUBE" = "true" ]; then
  RUNTIME_SERVICES="redis sonarqube-db sonarqube"
fi
echo "Runtime sidecars to start: $RUNTIME_SERVICES"

cat > /etc/systemd/system/arcagent-runtime-stack.service <<SERVICEEOF
[Unit]
Description=ArcAgent runtime sidecars (Redis/SonarQube)
After=network-online.target docker.service
Wants=network-online.target docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/arcagent/runtime
ExecStart=/usr/local/bin/arcagent-compose -f /opt/arcagent/runtime/docker-compose.yml up -d $RUNTIME_SERVICES
ExecStop=/usr/local/bin/arcagent-compose -f /opt/arcagent/runtime/docker-compose.yml down
TimeoutStartSec=300
TimeoutStopSec=120

[Install]
WantedBy=multi-user.target
SERVICEEOF

systemctl daemon-reload
systemctl enable arcagent-runtime-stack
systemctl start arcagent-runtime-stack

systemctl is-active --quiet arcagent-runtime-stack
/usr/local/bin/arcagent-compose -f /opt/arcagent/runtime/docker-compose.yml ps

# ---------------------------------------------------------------------------
# 5. Create worker user and directories
# ---------------------------------------------------------------------------
echo ">>> Setting up worker user and directories..."

# Create arcagent user (no fixed UID — UID 1000 is typically taken by 'ubuntu')
if ! id -u arcagent &>/dev/null; then
  useradd -m -s /bin/bash arcagent
fi

# Process backend execution user (used in dedicated attempt VM mode)
if ! id -u agent &>/dev/null; then
  useradd -m -s /bin/bash -U agent
fi
# Defense in depth: ensure the execution user cannot escalate via sudo.
gpasswd -d agent sudo >/dev/null 2>&1 || true
# Keep a stable, non-root writable workspace path for process backend mode.
install -d -m 0755 -o agent -g agent /workspace

# Block instance metadata access for agent commands (defense-in-depth).
iptables -C OUTPUT -m owner --uid-owner agent -d 169.254.169.254/32 -j REJECT 2>/dev/null || \
  iptables -A OUTPUT -m owner --uid-owner agent -d 169.254.169.254/32 -j REJECT
mkdir -p /etc/iptables
iptables-save > /etc/iptables/rules.v4

# Worker application directory
mkdir -p /opt/arcagent
chown -R arcagent:arcagent /opt/arcagent

# ---------------------------------------------------------------------------
# 6. Deploy provisioning scripts from repo (or pre-baked AMI)
# ---------------------------------------------------------------------------
echo ">>> Deploying provisioning scripts..."
mkdir -p /opt/arcagent/scripts
SCRIPT_NAMES=(setup-worker.sh detect-host-url.sh)
for script in "$${SCRIPT_NAMES[@]}"; do
  if aws s3 cp "s3://$ARTIFACT_BUCKET/scripts/$${script}" "/opt/arcagent/scripts/$${script}" --region "$AWS_REGION" --quiet; then
    chmod 755 "/opt/arcagent/scripts/$${script}"
  else
    echo "ERROR: Missing provisioning script s3://$ARTIFACT_BUCKET/scripts/$${script}"
    exit 1
  fi
done
chown -R root:root /opt/arcagent/scripts
echo "Provisioning scripts downloaded to /opt/arcagent/scripts."

# Optional: deploy worker build artifact from S3
if [ -n "$WORKER_ARTIFACT_S3_KEY" ]; then
  echo ">>> Downloading worker artifact s3://$ARTIFACT_BUCKET/$WORKER_ARTIFACT_S3_KEY..."
  mkdir -p /opt/arcagent/worker
  if aws s3 cp "s3://$ARTIFACT_BUCKET/$WORKER_ARTIFACT_S3_KEY" /tmp/worker-build.tar.gz --region "$AWS_REGION"; then
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
# 7. Write worker environment file
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
CONVEX_HTTP_ACTIONS_URL=$CONVEX_HTTP_ACTIONS_URL

# WORKER_HOST_URL can be fixed to a DNS URL (recommended for MCP), or
# auto-detected from instance public IP via ExecStartPre.
WORKER_HOST_URL=$WORKER_HOST_URL
WORKER_HOST_URL_LOCKED=$WORKER_HOST_URL_LOCKED
WORKER_ROUTE53_ZONE=$ROUTE53_ZONE_NAME
WORKER_DNS_NAME=$WORKER_DNS_NAME

# -------------------------------------------------------
# Workspace capacity
# -------------------------------------------------------
MAX_DEV_VMS=$MAX_DEV_VMS
WARM_POOL_SIZE=$WARM_POOL_SIZE
MAX_WARM_VMS=$MAX_WARM_VMS
WORKER_CONCURRENCY=$WORKER_CONCURRENCY
WORKSPACE_IDLE_TIMEOUT_MS=$WORKSPACE_IDLE_TIMEOUT_MS

# -------------------------------------------------------
# Execution backend configuration
# -------------------------------------------------------
WORKER_ROLE=$WORKER_ROLE
WORKER_EXECUTION_BACKEND=firecracker
WORKSPACE_ISOLATION_MODE=shared_worker
PROCESS_BACKEND_EXEC_USER=agent

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
# 8. Set up worker systemd service
# ---------------------------------------------------------------------------
echo ">>> Configuring systemd service..."
bash /opt/arcagent/scripts/setup-worker.sh

# ---------------------------------------------------------------------------
# 9. Start the worker
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
