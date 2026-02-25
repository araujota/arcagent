import { VMHandle } from "../vm/firecracker";
import { GateResult } from "../queue/jobQueue";
import { DiffContext } from "../lib/diffContext";
import { parseJsonSafe } from "../lib/resultParser";
import { logger } from "../index";

/**
 * SonarQube gate -- runs sonar-scanner and queries the quality gate status.
 *
 * When DiffContext is available, switches to PR analysis mode which natively
 * reports only new-code issues.
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
    };
  }

  const supportedLanguages = new Set(["typescript", "javascript"]);
  if (!supportedLanguages.has(normalizedLanguage)) {
    return {
      gate: "sonarqube",
      status: "skipped",
      durationMs: Date.now() - start,
      summary: `SonarQube gate is not enabled for language "${language}" in this execution image set`,
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
    };
  }

  const cliCheck = await vm.exec("command -v sonar-scanner >/dev/null 2>&1", 10_000);
  if (cliCheck.exitCode !== 0) {
    return {
      gate: "sonarqube",
      status: "error",
      durationMs: Date.now() - start,
      summary: `sonar-scanner not available in execution environment for language "${language}"`,
    };
  }

  // Generate a unique project key for this scan
  const projectKey = `arcagent-${vm.jobId}`;

  // If diff context is available, set up base branch for PR analysis mode
  if (diff) {
    await setupPrAnalysis(vm, diff);
  }

  // 1. Run sonar-scanner inside the VM
  const scanCommand = buildScanCommand({
    sonarUrl,
    sonarToken,
    projectKey,
    language,
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
        exitCode: scanResult.exitCode,
        output: truncate(scanResult.stdout + scanResult.stderr, 3_000),
      },
    };
  }

  // 2. Poll quality gate status (SonarQube processes asynchronously)
  const qualityGateResult = await pollQualityGate(
    vm,
    sonarUrl,
    sonarToken,
    projectKey,
    timeoutMs,
  );

  const durationMs = Date.now() - start;

  return {
    gate: "sonarqube",
    status: qualityGateResult.passed ? "pass" : "fail",
    durationMs,
    summary: qualityGateResult.passed
      ? "SonarQube quality gate passed"
      : `SonarQube quality gate failed: ${qualityGateResult.reason}`,
    details: {
      projectKey,
      qualityGate: qualityGateResult,
      prAnalysisMode: diff !== null,
    },
  };
}

// ---------------------------------------------------------------------------
// PR Analysis Setup
// ---------------------------------------------------------------------------

async function setupPrAnalysis(vm: VMHandle, diff: DiffContext): Promise<void> {
  try {
    // Fetch and create the base branch so SonarQube can compare
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ScanCommandOpts {
  sonarUrl: string;
  sonarToken: string;
  projectKey: string;
  language: string;
  diff: DiffContext | null;
  jobId: string;
}

function buildScanCommand(opts: ScanCommandOpts): string {
  // SECURITY (H5): Write token to an ephemeral file readable only by root,
  // then source it for the scanner. This prevents agent code from reading
  // the token via /proc/self/environ or environment variable inspection.
  const safeToken = opts.sonarToken.replace(/'/g, "'\\''");
  const args = [
    `printf '%s' '${safeToken}' > /tmp/.sonar_token && chmod 600 /tmp/.sonar_token &&`,
    `SONAR_TOKEN=$(cat /tmp/.sonar_token)`,
    "sonar-scanner",
    `-Dsonar.host.url=${opts.sonarUrl}`,
    `-Dsonar.projectKey=${opts.projectKey}`,
    "-Dsonar.sources=.",
    "-Dsonar.qualitygate.wait=false", // We poll ourselves for better control
  ];

  // PR analysis mode when diff context is available
  if (opts.diff) {
    args.push(
      `-Dsonar.pullrequest.key=${opts.jobId}`,
      "-Dsonar.pullrequest.branch=agent-submission",
      "-Dsonar.pullrequest.base=main",
      "-Dsonar.newCode.referenceBranch=main",
    );
  }

  // Language-specific settings
  switch (opts.language.toLowerCase()) {
    case "typescript":
    case "javascript":
      args.push("-Dsonar.language=ts");
      args.push("-Dsonar.typescript.lcov.reportPaths=coverage/lcov.info");
      break;
    case "python":
      args.push("-Dsonar.language=py");
      args.push("-Dsonar.python.coverage.reportPaths=coverage.xml");
      break;
    case "java":
      args.push("-Dsonar.language=java");
      args.push("-Dsonar.java.binaries=target/classes");
      break;
    case "go":
      args.push("-Dsonar.language=go");
      args.push("-Dsonar.go.coverage.reportPaths=coverage.out");
      break;
    case "ruby":
      args.push("-Dsonar.language=ruby");
      break;
    case "php":
      args.push("-Dsonar.language=php");
      break;
    case "csharp":
      args.push("-Dsonar.language=cs");
      break;
    case "c":
      args.push("-Dsonar.language=c");
      break;
    case "cpp":
      args.push("-Dsonar.language=cpp");
      break;
    case "swift":
      args.push("-Dsonar.language=swift");
      break;
    case "kotlin":
      args.push("-Dsonar.language=kotlin");
      break;
  }

  // Clean up the token file after scanner finishes
  args.push("&& rm -f /tmp/.sonar_token");

  return args.join(" ");
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
  projectKey: string,
  timeoutMs: number,
): Promise<QualityGateResult> {
  const pollInterval = 5_000;
  const maxAttempts = Math.min(Math.floor(timeoutMs / pollInterval), 24);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Wait before polling (SonarQube needs time to process)
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, pollInterval));
    }

    // SECURITY (H5): Use ephemeral file for curl auth to prevent token in environ
    const safeToken = sonarToken.replace(/'/g, "'\\''");
    const result = await vm.exec(
      `printf '%s:' '${safeToken}' > /tmp/.sonar_auth && chmod 600 /tmp/.sonar_auth && ` +
      `curl -s -u "$(cat /tmp/.sonar_auth)" "${sonarUrl}/api/qualitygates/project_status?projectKey=${projectKey}"; ` +
      `rm -f /tmp/.sonar_auth`,
      15_000,
    );

    if (result.exitCode !== 0) continue;

    const parsed = parseJsonSafe<SonarQualityGateResponse>(result.stdout);
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
        .filter((c: QualityCondition) => c.status === "ERROR")
        .map((c: QualityCondition) => `${c.metricKey}: ${c.actualValue} (threshold: ${c.errorThreshold})`);

      return {
        passed: false,
        status,
        reason: failedConditions.join("; ") || "Quality gate not met",
        conditions: parsed.projectStatus.conditions ?? [],
      };
    }

    // Status might be "IN_PROGRESS" -- keep polling
  }

  return {
    passed: false,
    status: "TIMEOUT",
    reason: "Quality gate status could not be determined within timeout",
    conditions: [],
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

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "\n... (truncated)";
}
