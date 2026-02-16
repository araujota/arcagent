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

# ---------------------------------------------------------------------------
# 2. Create systemd service
# ---------------------------------------------------------------------------
echo "Writing systemd service file..."

cat > "$SERVICE_FILE" <<'SERVICEEOF'
[Unit]
Description=ArcAgent Worker — Firecracker VM orchestrator
Documentation=https://github.com/your-org/arcagent
After=network-online.target redis-server.service
Wants=network-online.target redis-server.service

[Service]
Type=simple
User=root
# Root required for: creating TAP devices, iptables rules, jailer execution,
# dm-crypt setup. The worker itself is Node.js but needs these host privileges.
# Individual VM commands run as the unprivileged "agent" user inside the VM.

WorkingDirectory=/opt/arcagent/worker
EnvironmentFile=/opt/arcagent/worker.env

# Re-detect WORKER_HOST_URL on every start. The EIP may not be attached
# during the initial user-data run, but it will be by the time the service
# restarts. This ensures the correct public IP is always used.
ExecStartPre=/opt/arcagent/scripts/detect-host-url.sh

ExecStart=/usr/bin/node dist/index.js

# Graceful shutdown: SIGTERM triggers the shutdown handler in index.ts
# which destroys all sessions and drains the VM pool
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
# Can't use PrivateTmp because Firecracker uses /tmp for vsock sockets, overlays, etc.

# Resource limits
LimitNOFILE=65536
LimitNPROC=32768

[Install]
WantedBy=multi-user.target
SERVICEEOF

echo "systemd service written to $SERVICE_FILE"

# ---------------------------------------------------------------------------
# 3. Create log rotation
# ---------------------------------------------------------------------------
cat > /etc/logrotate.d/arcagent-worker <<'LOGEOF'
/var/log/arcagent-*.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    create 640 arcagent arcagent
}
LOGEOF

# ---------------------------------------------------------------------------
# 4. Create deployment helper script
# ---------------------------------------------------------------------------
cat > /opt/arcagent/deploy.sh <<'DEPLOYEOF'
#!/usr/bin/env bash
# Quick deployment script — run on the worker host
# Usage: bash /opt/arcagent/deploy.sh /path/to/worker-build.tar.gz
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <worker-build.tar.gz>"
  echo ""
  echo "Build the archive on your dev machine:"
  echo "  cd worker && npm run build"
  echo "  tar czf worker-build.tar.gz dist/ package.json package-lock.json"
  exit 1
fi

ARCHIVE="$1"
WORKER_DIR="/opt/arcagent/worker"

echo "Stopping worker service..."
systemctl stop arcagent-worker || true

echo "Deploying from $ARCHIVE..."
mkdir -p "$WORKER_DIR"
tar -xzf "$ARCHIVE" -C "$WORKER_DIR"

echo "Installing production dependencies..."
cd "$WORKER_DIR"
npm ci --production

echo "Starting worker service..."
systemctl start arcagent-worker

echo "Deployment complete. Status:"
systemctl status arcagent-worker --no-pager
DEPLOYEOF
chmod 755 /opt/arcagent/deploy.sh

echo "Worker service setup complete."
echo "  Start:   systemctl start arcagent-worker"
echo "  Stop:    systemctl stop arcagent-worker"
echo "  Logs:    journalctl -u arcagent-worker -f"
echo "  Deploy:  bash /opt/arcagent/deploy.sh <worker-build.tar.gz>"
