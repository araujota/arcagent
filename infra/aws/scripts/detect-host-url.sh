#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Detect the public IP via IMDSv2 and update WORKER_HOST_URL in worker.env.
#
# Called as ExecStartPre in the systemd service — runs before every worker
# start. This ensures WORKER_HOST_URL reflects the current EIP, even if
# the EIP was attached after the initial user-data run.
# ---------------------------------------------------------------------------
set -euo pipefail

ENV_FILE="/opt/arcagent/worker.env"
PORT=$(grep -oP '^PORT=\K.*' "$ENV_FILE" 2>/dev/null || echo "3001")

# Get IMDSv2 token
TOKEN=$(curl -sf -X PUT "http://169.254.169.254/latest/api/token" \
  -H "X-aws-ec2-metadata-token-ttl-seconds: 30" 2>/dev/null || echo "")

if [ -z "$TOKEN" ]; then
  echo "[detect-host-url] IMDSv2 token unavailable — keeping existing WORKER_HOST_URL"
  exit 0
fi

# Get public IP
PUBLIC_IP=$(curl -sf -H "X-aws-ec2-metadata-token: $TOKEN" \
  "http://169.254.169.254/latest/meta-data/public-ipv4" 2>/dev/null || echo "")

if [ -z "$PUBLIC_IP" ]; then
  echo "[detect-host-url] No public IP found — keeping existing WORKER_HOST_URL"
  exit 0
fi

NEW_URL="http://$PUBLIC_IP:$PORT"

# Only update if changed
CURRENT_URL=$(grep -oP '^WORKER_HOST_URL=\K.*' "$ENV_FILE" 2>/dev/null || echo "")
if [ "$CURRENT_URL" = "$NEW_URL" ]; then
  echo "[detect-host-url] WORKER_HOST_URL unchanged: $NEW_URL"
  exit 0
fi

# Update the env file
if grep -q "^WORKER_HOST_URL=" "$ENV_FILE"; then
  sed -i "s|^WORKER_HOST_URL=.*|WORKER_HOST_URL=$NEW_URL|" "$ENV_FILE"
else
  echo "WORKER_HOST_URL=$NEW_URL" >> "$ENV_FILE"
fi

echo "[detect-host-url] Updated WORKER_HOST_URL to $NEW_URL"
