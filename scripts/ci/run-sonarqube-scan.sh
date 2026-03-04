#!/usr/bin/env bash
set -euo pipefail

ARTIFACT_DIR="${ARTIFACT_DIR:-.artifacts/security}"
mkdir -p "$ARTIFACT_DIR"

if [[ -z "${SONARQUBE_URL:-}" ]]; then
  echo "ERROR: SONARQUBE_URL is required for blocking SonarQube scans."
  exit 1
fi

if [[ -z "${SONARQUBE_TOKEN:-}" ]]; then
  echo "ERROR: SONARQUBE_TOKEN is required for blocking SonarQube scans."
  exit 1
fi

sonar_scan_url="${SONARQUBE_SCAN_URL:-$SONARQUBE_URL}"

default_project_key="$(basename "$(git rev-parse --show-toplevel)")"
if [[ -n "${GITHUB_REPOSITORY:-}" ]]; then
  default_project_key="${GITHUB_REPOSITORY//\//_}"
fi

SONAR_PROJECT_KEY="${SONAR_PROJECT_KEY:-$default_project_key}"
SONAR_PROJECT_KEY="${SONAR_PROJECT_KEY//\//_}"
SONAR_PROJECT_NAME="${SONAR_PROJECT_NAME:-$SONAR_PROJECT_KEY}"

report_task_file="${ARTIFACT_DIR}/sonar-report-task.txt"

scanner_args=(
  "-Dsonar.projectKey=${SONAR_PROJECT_KEY}"
  "-Dsonar.projectName=${SONAR_PROJECT_NAME}"
  "-Dsonar.host.url=${sonar_scan_url}"
  "-Dsonar.token=${SONARQUBE_TOKEN}"
)

echo "Running SonarQube scan for project key: ${SONAR_PROJECT_KEY}"
if command -v sonar-scanner >/dev/null 2>&1; then
  sonar-scanner \
    "${scanner_args[@]}" \
    "-Dsonar.scanner.metadataFilePath=${PWD}/${report_task_file}"
else
  echo "sonar-scanner not found locally, using Docker image."
  docker run --rm \
    -e SONAR_USER_HOME=/tmp/.sonar \
    -v "$PWD:/usr/src" \
    -w /usr/src \
    sonarsource/sonar-scanner-cli:latest \
    "${scanner_args[@]}" \
    "-Dsonar.scanner.metadataFilePath=/usr/src/${report_task_file}"
fi

if [[ ! -f "$report_task_file" ]]; then
  echo "ERROR: SonarQube scanner did not produce ${report_task_file}."
  exit 1
fi

ce_task_url="$(awk -F= '/^ceTaskUrl=/{print $2}' "$report_task_file")"
ce_task_id="$(awk -F= '/^ceTaskId=/{print $2}' "$report_task_file")"
if [[ -z "$ce_task_url" && -z "$ce_task_id" ]]; then
  echo "ERROR: Missing ceTaskUrl/ceTaskId in ${report_task_file}."
  exit 1
fi

if [[ -n "$ce_task_id" ]]; then
  ce_task_url="${SONARQUBE_URL%/}/api/ce/task?id=${ce_task_id}"
else
  scan_url_base="${sonar_scan_url%/}"
  api_url_base="${SONARQUBE_URL%/}"
  if [[ "$scan_url_base" != "$api_url_base" ]]; then
    ce_task_url="${ce_task_url/$scan_url_base/$api_url_base}"
  fi
fi

ce_response_file="${ARTIFACT_DIR}/sonar-ce-task.json"
analysis_id=""
ce_poll_attempts="${SONAR_CE_POLL_ATTEMPTS:-60}"
ce_poll_interval="${SONAR_CE_POLL_INTERVAL_SECONDS:-5}"

echo "Polling SonarQube compute engine task..."
for attempt in $(seq 1 "$ce_poll_attempts"); do
  curl -sSf -u "${SONARQUBE_TOKEN}:" "$ce_task_url" >"$ce_response_file"
  ce_status="$(node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String(j.task?.status||""));' "$ce_response_file")"

  if [[ "$ce_status" == "SUCCESS" ]]; then
    analysis_id="$(node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String(j.task?.analysisId||""));' "$ce_response_file")"
    break
  fi

  if [[ "$ce_status" == "FAILED" || "$ce_status" == "CANCELED" ]]; then
    echo "ERROR: SonarQube compute task ended with status ${ce_status}."
    cat "$ce_response_file"
    exit 1
  fi

  sleep "$ce_poll_interval"
done

if [[ -z "$analysis_id" ]]; then
  echo "ERROR: Timed out waiting for SonarQube compute task."
  cat "$ce_response_file"
  exit 1
fi

qg_response_file="${ARTIFACT_DIR}/sonar-quality-gate.json"
curl -sSf -u "${SONARQUBE_TOKEN}:" \
  "${SONARQUBE_URL%/}/api/qualitygates/project_status?analysisId=${analysis_id}" >"$qg_response_file"

measures_response_file="${ARTIFACT_DIR}/sonar-measures.json"
curl -sSf -u "${SONARQUBE_TOKEN}:" \
  "${SONARQUBE_URL%/}/api/measures/component?component=${SONAR_PROJECT_KEY}&metricKeys=bugs,code_smells,new_bugs,new_code_smells,vulnerabilities,new_vulnerabilities,security_hotspots,new_security_hotspots" >"$measures_response_file"

echo "Sonar summary (bugs/smells/complexity-related metrics):"
node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const map=new Map((j.component?.measures||[]).map(m=>[m.metric,m.period?.value ?? m.value ?? "n/a"]));const keys=["bugs","code_smells","new_bugs","new_code_smells","vulnerabilities","new_vulnerabilities","security_hotspots","new_security_hotspots"];for (const k of keys) console.log(`  ${k}: ${map.get(k) ?? "n/a"}`);' "$measures_response_file"

qg_status="$(node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String(j.projectStatus?.status||""));' "$qg_response_file")"
if [[ "$qg_status" != "OK" ]]; then
  echo "SonarQube quality gate status: ${qg_status}"
  node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));for (const c of (j.projectStatus?.conditions||[])) { if (c.status !== "OK") console.log(`${c.metricKey}: ${c.status} (actual=${c.actualValue ?? "n/a"}, threshold=${c.errorThreshold ?? "n/a"})`); }' "$qg_response_file"
  exit 1
fi

echo "SonarQube quality gate passed."
