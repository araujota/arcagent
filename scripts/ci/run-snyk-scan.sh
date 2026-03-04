#!/usr/bin/env bash
set -euo pipefail

ARTIFACT_DIR="${ARTIFACT_DIR:-.artifacts/security}"
mkdir -p "$ARTIFACT_DIR"
oss_report="${ARTIFACT_DIR}/snyk-oss.json"
code_report="${ARTIFACT_DIR}/snyk-code.json"

# Snyk CLI may skip rewriting --json-file-output when there are no findings.
# Always clear prior artifacts so results reflect the current run.
rm -f "$oss_report" "$code_report"

if [[ -z "${SNYK_TOKEN:-}" ]]; then
  echo "ERROR: SNYK_TOKEN is required for blocking Snyk scans."
  exit 1
fi

echo "Running Snyk open source dependency scan..."
sca_exit=0
set +e
if [[ -n "${SNYK_ORG:-}" ]]; then
  npx --yes snyk@latest test \
    --all-projects \
    --detection-depth=10 \
    --severity-threshold=high \
    --org="$SNYK_ORG" \
    --json-file-output="$oss_report"
else
  npx --yes snyk@latest test \
    --all-projects \
    --detection-depth=10 \
    --severity-threshold=high \
    --json-file-output="$oss_report"
fi
sca_exit=$?
set -e

echo "Running Snyk code scan..."
code_exit=0
set +e
if [[ -n "${SNYK_ORG:-}" ]]; then
  npx --yes snyk@latest code test \
    --severity-threshold=high \
    --org="$SNYK_ORG" \
    --json-file-output="$code_report"
else
  npx --yes snyk@latest code test \
    --severity-threshold=high \
    --json-file-output="$code_report"
fi
code_exit=$?
set -e

# Normalize artifacts for successful no-finding runs.
if [[ "$sca_exit" -eq 0 && ! -s "$oss_report" ]]; then
  printf '[]\n' >"$oss_report"
fi
if [[ "$code_exit" -eq 0 && ! -s "$code_report" ]]; then
  printf '{"runs":[{"results":[]}]}\n' >"$code_report"
fi

if [[ "$sca_exit" -ne 0 || "$code_exit" -ne 0 ]]; then
  echo "Snyk scan failed (oss_exit=${sca_exit}, code_exit=${code_exit})."
  exit 1
fi

echo "Snyk scans passed."
