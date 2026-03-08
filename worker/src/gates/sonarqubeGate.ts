import { VMHandle } from "../vm/firecracker";
import { GateResult } from "../queue/jobQueue";
import { DiffContext } from "../lib/diffContext";
import { parseJsonSafe } from "../lib/resultParser";
import { logger } from "../index";

const GENERIC_CLI_SONAR_LANGUAGES = new Set([
  "typescript",
  "javascript",
  "python",
  "go",
  "java",
  "kotlin",
  "ruby",
  "php",
  "rust",
]);

/**
 * SonarQube gate -- runs sonar-scanner and waits for the compute-engine task
 * before querying the quality gate for the resulting analysis.
 *
 * Expects `SONARQUBE_URL` and `SONARQUBE_TOKEN` environment variables.
 * If SonarQube is not configured the gate is skipped gracefully.
 */
export async function runSonarQubeGate(
  vm: VMHandle,
  language: string,
  timeoutMs: number,
  diff: DiffContext | null,
): Promise<GateResult> {
  const start = Date.now();
  const normalizedLanguage = language.toLowerCase();

  const sonarUrl = process.env.SONARQUBE_URL;
  const sonarToken = process.env.SONARQUBE_TOKEN;

  if (!sonarUrl || !sonarToken) {
    return {
      gate: "sonarqube",
      status: "skipped",
      durationMs: Date.now() - start,
      summary: "SonarQube not configured (SONARQUBE_URL / SONARQUBE_TOKEN missing)",
      details: {
        reasonCode: "missing_config",
      },
    };
  }

  if (!GENERIC_CLI_SONAR_LANGUAGES.has(normalizedLanguage)) {
    return {
      gate: "sonarqube",
      status: "skipped",
      durationMs: Date.now() - start,
      summary: `SonarQube generic CLI analysis is not supported for language "${language}"`,
      details: {
        reasonCode: "unsupported_language",
        language: normalizedLanguage,
      },
    };
  }

  const hardenEgress = process.env.FC_HARDEN_EGRESS !== "false"
    && (process.env.FC_HARDEN_EGRESS === "true" || process.env.NODE_ENV === "production");
  if (hardenEgress && !sonarUrl.startsWith("https://")) {
    return {
      gate: "sonarqube",
      status: "error",
      durationMs: Date.now() - start,
      summary: "SonarQube URL must use https:// when hardened egress is enabled",
      details: {
        reasonCode: "invalid_url_scheme",
      },
    };
  }

  const cliCheck = await vm.exec("command -v sonar-scanner >/dev/null 2>&1", 10_000);
  if (cliCheck.exitCode !== 0) {
    return {
      gate: "sonarqube",
      status: "error",
      durationMs: Date.now() - start,
      summary: `sonar-scanner not available in execution environment for language "${language}"`,
      details: {
        reasonCode: "missing_cli",
      },
    };
  }

  const projectKey = `arcagent-${vm.jobId}`;

  if (diff) {
    await setupPrAnalysis(vm, diff);
  }

  const scanCommand = buildScanCommand({
    sonarUrl,
    sonarToken,
    projectKey,
    language: normalizedLanguage,
    diff,
    jobId: vm.jobId,
  });

  const scanResult = await vm.exec(
    `cd /workspace && ${scanCommand} 2>&1`,
    timeoutMs,
  );

  if (scanResult.exitCode !== 0) {
    logger.warn("SonarQube scan failed", {
      jobId: vm.jobId,
      exitCode: scanResult.exitCode,
      stderr: scanResult.stderr.slice(0, 500),
    });

    return {
      gate: "sonarqube",
      status: "error",
      durationMs: Date.now() - start,
      summary: `SonarQube scanner failed with exit code ${scanResult.exitCode}`,
      details: {
        reasonCode: "scanner_failed",
        exitCode: scanResult.exitCode,
        output: truncate(scanResult.stdout + scanResult.stderr, 3_000),
      },
    };
  }

  const ceTaskId = await readCeTaskId(vm, projectKey);
  if (!ceTaskId) {
    return {
      gate: "sonarqube",
      status: "error",
      durationMs: Date.now() - start,
      summary: "SonarQube scanner did not produce report-task metadata",
      details: {
        reasonCode: "missing_report_task",
        projectKey,
      },
    };
  }

  const qualityGateResult = await pollQualityGate(
    vm,
    sonarUrl,
    sonarToken,
    ceTaskId,
    timeoutMs,
  );

  const detailResult = await fetchNewCodeDetails(
    vm,
    sonarUrl,
    sonarToken,
    projectKey,
  );

  const durationMs = Date.now() - start;
  const qualityGateTimedOut = qualityGateResult.status === "TIMEOUT";
  const gateStatus: GateResult["status"] = qualityGateTimedOut
    ? "error"
    : qualityGateResult.passed
      ? "pass"
      : "fail";
  const summary = qualityGateTimedOut
    ? "SonarQube quality gate polling timed out"
    : qualityGateResult.passed
      ? "SonarQube quality gate passed"
      : `SonarQube quality gate failed: ${qualityGateResult.reason}`;

  return {
    gate: "sonarqube",
    status: gateStatus,
    durationMs,
    summary,
    details: {
      ...(qualityGateTimedOut ? { reasonCode: "quality_gate_timeout" } : {}),
      projectKey,
      qualityGate: qualityGateResult,
      prAnalysisMode: diff !== null,
      metrics: detailResult.metrics,
      issues: detailResult.issues,
      fetchErrors: detailResult.fetchErrors,
      language: normalizedLanguage,
    },
  };
}

async function setupPrAnalysis(vm: VMHandle, diff: DiffContext): Promise<void> {
  try {
    await vm.exec(
      `cd /workspace && ` +
      `git fetch origin ${diff.baseCommitSha} 2>&1 && ` +
      `git checkout -b main ${diff.baseCommitSha} 2>&1 && ` +
      `git checkout ${diff.agentCommitSha} 2>&1`,
      30_000,
    );
  } catch {
    logger.warn("Failed to set up PR analysis branches, falling back to whole-project analysis");
  }
}

interface ScanCommandOpts {
  sonarUrl: string;
  sonarToken: string;
  projectKey: string;
  language: string;
  diff: DiffContext | null;
  jobId: string;
}

function buildScanCommand(opts: ScanCommandOpts): string {
  const safeToken = opts.sonarToken.replace(/'/g, "'\\''");
  const args = [
    `printf '%s' '${safeToken}' > /tmp/.sonar_token && chmod 600 /tmp/.sonar_token &&`,
    "sonar-scanner",
    `-Dsonar.token=$(cat /tmp/.sonar_token)`,
    `-Dsonar.host.url=${opts.sonarUrl}`,
    `-Dsonar.projectKey=${opts.projectKey}`,
    "-Dsonar.sources=.",
    "-Dsonar.qualitygate.wait=false",
    "-Dsonar.scanner.metadataFilePath=/tmp/sonar-report-task.txt",
  ];

  if (opts.diff) {
    args.push(
      `-Dsonar.pullrequest.key=${opts.jobId}`,
      "-Dsonar.pullrequest.branch=agent-submission",
      "-Dsonar.pullrequest.base=main",
      "-Dsonar.newCode.referenceBranch=main",
    );
  }

  switch (opts.language) {
    case "typescript":
    case "javascript":
      args.push("-Dsonar.typescript.lcov.reportPaths=coverage/lcov.info");
      break;
    case "python":
      args.push("-Dsonar.python.coverage.reportPaths=coverage.xml");
      break;
    case "go":
      args.push("-Dsonar.go.coverage.reportPaths=coverage.out");
      break;
    case "java":
    case "kotlin":
      args.push("-Dsonar.java.binaries=target/classes,build/classes");
      break;
  }

  args.push("; code=$?; rm -f /tmp/.sonar_token; exit $code");
  return args.join(" ");
}

async function readCeTaskId(vm: VMHandle, projectKey: string): Promise<string | null> {
  const result = await vm.exec(
    "if [ -f /tmp/sonar-report-task.txt ]; then cat /tmp/sonar-report-task.txt; else exit 1; fi",
    5_000,
  );
  if (result.exitCode !== 0) return null;

  const lines = result.stdout.split("\n");
  const metadataProjectKey = lines
    .find((line) => line.startsWith("projectKey="))
    ?.slice("projectKey=".length)
    .trim();
  const ceTaskId = lines
    .find((line) => line.startsWith("ceTaskId="))
    ?.slice("ceTaskId=".length)
    .trim();

  if (metadataProjectKey && metadataProjectKey !== projectKey) {
    logger.warn("Sonar report-task project key mismatch", {
      jobId: vm.jobId,
      expectedProjectKey: projectKey,
      metadataProjectKey,
    });
  }

  return ceTaskId || null;
}

interface QualityGateResult {
  passed: boolean;
  status: string;
  reason: string;
  conditions: unknown[];
}

async function pollQualityGate(
  vm: VMHandle,
  sonarUrl: string,
  sonarToken: string,
  ceTaskId: string,
  timeoutMs: number,
): Promise<QualityGateResult> {
  const pollInterval = 5_000;
  const maxAttempts = Math.min(Math.floor(timeoutMs / pollInterval), 24);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    const safeToken = sonarToken.replace(/'/g, "'\\''");
    const ceResult = await vm.exec(
      `printf '%s:' '${safeToken}' > /tmp/.sonar_auth && chmod 600 /tmp/.sonar_auth && ` +
      `curl -s -u "$(cat /tmp/.sonar_auth)" "${sonarUrl}/api/ce/task?id=${ceTaskId}"; ` +
      `rm -f /tmp/.sonar_auth`,
      15_000,
    );
    if (ceResult.exitCode !== 0) continue;

    const ceTask = parseJsonSafe<SonarCeTaskResponse>(ceResult.stdout);
    const ceStatus = ceTask?.task?.status;
    if (!ceStatus) continue;

    if (ceStatus === "FAILED" || ceStatus === "CANCELED") {
      return {
        passed: false,
        status: ceStatus,
        reason: "SonarQube compute engine task failed",
        conditions: [],
      };
    }

    const analysisId = ceTask?.task?.analysisId;
    if (ceStatus !== "SUCCESS" || !analysisId) {
      continue;
    }

    const qualityGateResult = await vm.exec(
      `printf '%s:' '${safeToken}' > /tmp/.sonar_auth && chmod 600 /tmp/.sonar_auth && ` +
      `curl -s -u "$(cat /tmp/.sonar_auth)" "${sonarUrl}/api/qualitygates/project_status?analysisId=${analysisId}"; ` +
      `rm -f /tmp/.sonar_auth`,
      15_000,
    );
    if (qualityGateResult.exitCode !== 0) continue;

    const parsed = parseJsonSafe<SonarQualityGateResponse>(qualityGateResult.stdout);
    if (!parsed?.projectStatus) continue;

    const status = parsed.projectStatus.status;
    if (status === "OK" || status === "NONE") {
      return {
        passed: true,
        status,
        reason: "All conditions met",
        conditions: parsed.projectStatus.conditions ?? [],
      };
    }

    if (status === "ERROR") {
      const failedConditions = (parsed.projectStatus.conditions ?? [])
        .filter((condition: QualityCondition) => condition.status === "ERROR")
        .map((condition: QualityCondition) =>
          `${condition.metricKey}: ${condition.actualValue} (threshold: ${condition.errorThreshold})`,
        );

      return {
        passed: false,
        status,
        reason: failedConditions.join("; ") || "Quality gate not met",
        conditions: parsed.projectStatus.conditions ?? [],
      };
    }
  }

  return {
    passed: false,
    status: "TIMEOUT",
    reason: "Quality gate status could not be determined within timeout",
    conditions: [],
  };
}

async function fetchNewCodeDetails(
  vm: VMHandle,
  sonarUrl: string,
  sonarToken: string,
  projectKey: string,
): Promise<{
  metrics: Record<string, number>;
  issues: Array<Record<string, unknown>>;
  fetchErrors: string[];
}> {
  const metrics: Record<string, number> = {};
  let issues: Array<Record<string, unknown>> = [];
  const fetchErrors: string[] = [];

  const safeToken = sonarToken.replace(/'/g, "'\\''");

  const metricsResult = await vm.exec(
    `printf '%s:' '${safeToken}' > /tmp/.sonar_auth && chmod 600 /tmp/.sonar_auth && ` +
    `curl -s -u "$(cat /tmp/.sonar_auth)" "${sonarUrl}/api/measures/component?component=${projectKey}&metricKeys=new_bugs,new_code_smells,new_maintainability_issues,new_cognitive_complexity,new_complexity"; ` +
    `rm -f /tmp/.sonar_auth`,
    15_000,
  );

  if (metricsResult.exitCode === 0) {
    const parsed = parseJsonSafe<SonarMeasuresResponse>(metricsResult.stdout);
    for (const measure of parsed?.component?.measures ?? []) {
      const value = Number(measure.value ?? measure.period?.value ?? "0");
      if (Number.isFinite(value)) {
        metrics[measure.metric] = value;
      }
    }
  } else {
    fetchErrors.push("Failed to fetch Sonar new-code metrics");
  }

  const issuesResult = await vm.exec(
    `printf '%s:' '${safeToken}' > /tmp/.sonar_auth && chmod 600 /tmp/.sonar_auth && ` +
    `curl -s -u "$(cat /tmp/.sonar_auth)" "${sonarUrl}/api/issues/search?componentKeys=${projectKey}&inNewCodePeriod=true&p=1&ps=500"; ` +
    `rm -f /tmp/.sonar_auth`,
    15_000,
  );

  if (issuesResult.exitCode === 0) {
    const parsed = parseJsonSafe<SonarIssuesResponse>(issuesResult.stdout);
    issues = (parsed?.issues ?? []) as Array<Record<string, unknown>>;
  } else {
    fetchErrors.push("Failed to fetch Sonar new-code issues");
  }

  return { metrics, issues: issues.slice(0, 500), fetchErrors };
}

interface SonarCeTaskResponse {
  task?: {
    status?: string;
    analysisId?: string;
  };
}

interface SonarQualityGateResponse {
  projectStatus?: {
    status: string;
    conditions?: QualityCondition[];
  };
}

interface QualityCondition {
  status: string;
  metricKey: string;
  comparator: string;
  errorThreshold: string;
  actualValue: string;
}

interface SonarMeasuresResponse {
  component?: {
    measures?: Array<{
      metric: string;
      value?: string;
      period?: { value?: string };
    }>;
  };
}

interface SonarIssuesResponse {
  issues?: Array<{
    key?: string;
    rule?: string;
    severity?: string;
    component?: string;
    line?: number;
    type?: string;
    message?: string;
  }>;
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "\n... (truncated)";
}
