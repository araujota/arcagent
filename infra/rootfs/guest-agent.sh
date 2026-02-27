#!/usr/bin/env bash
set -euo pipefail

# Compatibility wrapper. New images should invoke /usr/local/bin/vsock-agent
# directly; this keeps legacy callers working.
exec /usr/local/bin/vsock-agent "$@"
