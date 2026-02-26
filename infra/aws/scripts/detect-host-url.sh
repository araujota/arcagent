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
LOCKED=$(grep -oP '^WORKER_HOST_URL_LOCKED=\K.*' "$ENV_FILE" 2>/dev/null || echo "false")
ROUTE53_ZONE=$(grep -oP '^WORKER_ROUTE53_ZONE=\K.*' "$ENV_FILE" 2>/dev/null || echo "")
WORKER_DNS_NAME=$(grep -oP '^WORKER_DNS_NAME=\K.*' "$ENV_FILE" 2>/dev/null || echo "")

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

if [ "$LOCKED" != "true" ]; then
  CURRENT_URL=$(grep -oP '^WORKER_HOST_URL=\K.*' "$ENV_FILE" 2>/dev/null || echo "")
  if [ "$CURRENT_URL" != "$NEW_URL" ]; then
    if grep -q "^WORKER_HOST_URL=" "$ENV_FILE"; then
      sed -i "s|^WORKER_HOST_URL=.*|WORKER_HOST_URL=$NEW_URL|" "$ENV_FILE"
    else
      echo "WORKER_HOST_URL=$NEW_URL" >> "$ENV_FILE"
    fi
    echo "[detect-host-url] Updated WORKER_HOST_URL to $NEW_URL"
  else
    echo "[detect-host-url] WORKER_HOST_URL unchanged: $NEW_URL"
  fi
else
  echo "[detect-host-url] WORKER_HOST_URL_LOCKED=true — keeping configured URL"
fi

# Keep stable DNS record in sync when no EIP is available.
if [ -n "$ROUTE53_ZONE" ] && [ -n "$WORKER_DNS_NAME" ]; then
  if command -v aws >/dev/null 2>&1; then
    ZONE_ID=$(aws route53 list-hosted-zones-by-name \
      --dns-name "$ROUTE53_ZONE" \
      --query "HostedZones[?Name == '${ROUTE53_ZONE}.'].Id | [0]" \
      --output text 2>/dev/null || echo "")

    if [ -n "$ZONE_ID" ] && [ "$ZONE_ID" != "None" ]; then
      ZONE_ID="${ZONE_ID##*/}"
      CURRENT_DNS_IP=$(aws route53 list-resource-record-sets \
        --hosted-zone-id "$ZONE_ID" \
        --query "ResourceRecordSets[?Name == '${WORKER_DNS_NAME}.'] | [?Type == 'A'] | [0].ResourceRecords[0].Value" \
        --output text 2>/dev/null || echo "")

      if [ "$CURRENT_DNS_IP" != "$PUBLIC_IP" ]; then
        CHANGE_BATCH=$(mktemp)
        cat > "$CHANGE_BATCH" <<EOF
{
  "Comment": "Auto-sync worker DNS to current public IP",
  "Changes": [
    {
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "${WORKER_DNS_NAME}",
        "Type": "A",
        "TTL": 60,
        "ResourceRecords": [{ "Value": "${PUBLIC_IP}" }]
      }
    }
  ]
}
EOF
        aws route53 change-resource-record-sets \
          --hosted-zone-id "$ZONE_ID" \
          --change-batch "file://$CHANGE_BATCH" >/dev/null
        rm -f "$CHANGE_BATCH"
        echo "[detect-host-url] Updated Route53 ${WORKER_DNS_NAME} -> ${PUBLIC_IP}"
      else
        echo "[detect-host-url] Route53 ${WORKER_DNS_NAME} already points to ${PUBLIC_IP}"
      fi
    else
      echo "[detect-host-url] Could not resolve hosted zone id for ${ROUTE53_ZONE}"
    fi
  else
    echo "[detect-host-url] aws CLI not found; skipping Route53 sync"
  fi
fi
