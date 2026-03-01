#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Set up the ArcAgent worker as a systemd service
# ---------------------------------------------------------------------------
# Assumes:
#   - Node.js is installed
#   - /opt/arcagent/worker.env exists with environment variables
#   - Worker code is deployed to /opt/arcagent/worker/
# ---------------------------------------------------------------------------
set -euo pipefail

WORKER_DIR="/opt/arcagent/worker"
SERVICE_FILE="/etc/systemd/system/arcagent-worker.service"

# ---------------------------------------------------------------------------
# 1. Deploy worker code (if not already present)
# ---------------------------------------------------------------------------
if [ ! -d "$WORKER_DIR/dist" ]; then
  echo "Worker code not found at $WORKER_DIR/dist."
  echo "You need to deploy the worker build artifacts."
  echo ""
  echo "To deploy manually:"
  echo "  1. On your build machine: cd worker && npm run build"
  echo "  2. Copy to host: scp -r dist/ package.json package-lock.json ubuntu@<host>:/opt/arcagent/worker/"
  echo "  3. On host: cd /opt/arcagent/worker && npm ci --production"
  echo ""
  echo "Creating placeholder directory..."
  mkdir -p "$WORKER_DIR"
fi

if [ -f "$WORKER_DIR/package-lock.json" ]; then
  echo "Installing worker production dependencies..."
  cd "$WORKER_DIR"
  npm ci --omit=dev
fi

# ---------------------------------------------------------------------------
# 2. Create systemd service
# ---------------------------------------------------------------------------
echo "Writing systemd service file..."

cat > "$SERVICE_FILE" <<'SERVICEEOF'
[Unit]
Description=ArcAgent Worker — process backend orchestrator
Documentation=https://github.com/your-org/arcagent
After=network-online.target arcagent-runtime-stack.service
Wants=network-online.target arcagent-runtime-stack.service

[Service]
Type=notify
NotifyAccess=main
User=root
# Root required for: runuser/chown privilege drop into the execution user,
# metadata egress hardening rules, and runtime sidecar management.
# User code still runs as the unprivileged "agent" user.

WorkingDirectory=/opt/arcagent/worker
EnvironmentFile=/opt/arcagent/worker.env

# Re-detect WORKER_HOST_URL on every start. The EIP may not be attached
# during the initial user-data run, but it will be by the time the service
# restarts. This ensures the correct public IP is always used.
ExecStartPre=/opt/arcagent/scripts/detect-host-url.sh

ExecStart=/usr/bin/node dist/index.js

# Graceful shutdown: SIGTERM triggers the shutdown handler in index.ts
# which drains jobs and destroys active sessions.
KillSignal=SIGTERM
TimeoutStopSec=120

# Restart on failure with backoff
Restart=on-failure
RestartSec=5
StartLimitIntervalSec=300
StartLimitBurst=5

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=arcagent-worker

# Security hardening (what we can do while still needing root)
NoNewPrivileges=no
ProtectSystem=false
ProtectHome=read-only
PrivateTmp=false
# /tmp is used for process-backend isolated workspaces and should remain shared.

# Resource limits
LimitNOFILE=65536
LimitNPROC=32768
# Memory ceiling — OOM-kill if Node.js leaks beyond this (bare-metal has 32+ GB)
MemoryMax=8G
# Watchdog — systemd kills and restarts the process if it stops notifying.
# The worker process sends READY/WATCHDOG/STOPPING via systemd-notify.
WatchdogSec=120

[Install]
WantedBy=multi-user.target
SERVICEEOF

echo "systemd service written to $SERVICE_FILE"

# ---------------------------------------------------------------------------
# 3. Configure journal log retention
# ---------------------------------------------------------------------------
# Worker logs go to journald (StandardOutput=journal). Configure journal
# size limits to prevent unbounded disk usage on long-lived instances.
mkdir -p /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/arcagent.conf <<'JOURNALEOF'
[Journal]
SystemMaxUse=2G
SystemKeepFree=1G
MaxRetentionSec=14day
JOURNALEOF
systemctl restart systemd-journald 2>/dev/null || true

# ---------------------------------------------------------------------------
# 4. Create deployment helper script
# ---------------------------------------------------------------------------
cat > /opt/arcagent/deploy.sh <<'DEPLOYEOF'
#!/usr/bin/env bash
# Zero-interruption deployment script — run on the worker host
# Usage: bash /opt/arcagent/deploy.sh /path/to/worker-build.tar.gz [drain-timeout-seconds]
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <worker-build.tar.gz> [drain-timeout-seconds]"
  echo ""
  echo "Build the archive on your dev machine:"
  echo "  cd worker && npm run build"
  echo "  tar czf worker-build.tar.gz dist/ package.json package-lock.json"
  exit 1
fi

ARCHIVE="$1"
MAX_DRAIN_SECONDS="${2:-1800}"
WORKER_DIR="/opt/arcagent/worker"
RELEASES_DIR="/opt/arcagent/releases"
SERVICE_NAME="arcagent-worker"
QUEUE_NAME="verification"
REDIS_URL="$(grep '^REDIS_URL=' /opt/arcagent/worker.env | cut -d= -f2- || true)"

if [ -z "$REDIS_URL" ]; then
  REDIS_URL="redis://127.0.0.1:6379"
fi

if [ ! -f "$ARCHIVE" ]; then
  echo "Archive not found: $ARCHIVE"
  exit 1
fi

mkdir -p "$RELEASES_DIR"
RELEASE_ID="worker-$(date -u +%Y%m%d%H%M%S)"
STAGE_DIR="$RELEASES_DIR/$RELEASE_ID"
PREV_DIR="$RELEASES_DIR/rollback-$(date -u +%Y%m%d%H%M%S)"

queue_pause() {
  cd "$WORKER_DIR"
  REDIS_URL="$REDIS_URL" QUEUE_NAME="$QUEUE_NAME" node <<'NODE'
const { Queue } = require("bullmq");
const IORedis = require("ioredis");
const redisUrl = process.env.REDIS_URL;
const queueName = process.env.QUEUE_NAME || "verification";
(async () => {
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: false });
  const queue = new Queue(queueName, { connection });
  await queue.pause();
  await queue.close();
  await connection.quit();
})().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
NODE
}

queue_resume() {
  cd "$WORKER_DIR"
  REDIS_URL="$REDIS_URL" QUEUE_NAME="$QUEUE_NAME" node <<'NODE'
const { Queue } = require("bullmq");
const IORedis = require("ioredis");
const redisUrl = process.env.REDIS_URL;
const queueName = process.env.QUEUE_NAME || "verification";
(async () => {
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: false });
  const queue = new Queue(queueName, { connection });
  await queue.resume();
  await queue.close();
  await connection.quit();
})().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
NODE
}

queue_active_count() {
  redis-cli -u "$REDIS_URL" --raw LLEN "bull:${QUEUE_NAME}:active" 2>/dev/null || echo "0"
}

health_check() {
  curl -fsS -m 5 "http://127.0.0.1:3001/api/health" >/dev/null
}

rollback() {
  echo "Deploy failed. Rolling back..."
  systemctl stop "$SERVICE_NAME" || true
  if [ -d "$PREV_DIR" ]; then
    rm -rf "$WORKER_DIR"
    mv "$PREV_DIR" "$WORKER_DIR"
    systemctl start "$SERVICE_NAME" || true
  fi
  queue_resume || true
  exit 1
}

trap rollback ERR

echo "Staging release into $STAGE_DIR..."
mkdir -p "$STAGE_DIR"
tar -xzf "$ARCHIVE" -C "$STAGE_DIR"

echo "Installing production dependencies in staged release..."
cd "$STAGE_DIR"
npm ci --omit=dev

echo "Pausing verification queue to prevent new job assignment..."
queue_pause

echo "Waiting for in-progress verification jobs to finish (timeout: ${MAX_DRAIN_SECONDS}s)..."
start_ts="$(date +%s)"
while true; do
  active="$(queue_active_count)"
  if [ "$active" = "0" ]; then
    break
  fi
  now_ts="$(date +%s)"
  elapsed="$((now_ts - start_ts))"
  if [ "$elapsed" -ge "$MAX_DRAIN_SECONDS" ]; then
    echo "Timed out waiting for active jobs to drain (active=$active)."
    exit 1
  fi
  sleep 2
done

echo "Switching release and restarting worker..."
systemctl stop "$SERVICE_NAME"
if [ -d "$WORKER_DIR" ]; then
  mv "$WORKER_DIR" "$PREV_DIR"
fi
mv "$STAGE_DIR" "$WORKER_DIR"
systemctl start "$SERVICE_NAME"

echo "Waiting for worker health..."
for _ in $(seq 1 30); do
  if health_check; then
    break
  fi
  sleep 1
done
health_check

echo "Resuming verification queue..."
queue_resume

echo "Deployment complete. Status:"
systemctl status "$SERVICE_NAME" --no-pager

echo "Cleaning up previous release..."
rm -rf "$PREV_DIR" || true

trap - ERR
DEPLOYEOF
chmod 755 /opt/arcagent/deploy.sh

echo "Worker service setup complete."
echo "  Start:   systemctl start arcagent-worker"
echo "  Stop:    systemctl stop arcagent-worker"
echo "  Logs:    journalctl -u arcagent-worker -f"
echo "  Deploy:  bash /opt/arcagent/deploy.sh <worker-build.tar.gz>"
