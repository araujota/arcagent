#!/usr/bin/env bash
set -euo pipefail

echo "Validating deployment defaults for process runtime..."

SETUP_HOST_FILE="infra/aws/scripts/setup-host.sh"
if ! grep -q '^WORKER_EXECUTION_BACKEND=process$' "$SETUP_HOST_FILE"; then
  echo "ERROR: $SETUP_HOST_FILE must default to WORKER_EXECUTION_BACKEND=process"
  exit 1
fi

if grep -R -n 'WORKER_EXECUTION_BACKEND=firecracker' infra/aws >/dev/null 2>&1; then
  echo "ERROR: Deployment configs must not set WORKER_EXECUTION_BACKEND=firecracker"
  grep -R -n 'WORKER_EXECUTION_BACKEND=firecracker' infra/aws
  exit 1
fi

if grep -R -n 'WORKSPACE_ISOLATION_MODE=dedicated_attempt_vm' infra/aws >/dev/null 2>&1; then
  echo "ERROR: Deployment configs must not set dedicated attempt workspace mode"
  grep -R -n 'WORKSPACE_ISOLATION_MODE=dedicated_attempt_vm' infra/aws
  exit 1
fi

echo "Process deployment config checks passed."
