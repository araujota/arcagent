import { VMHandle } from "../vm/firecracker";
import { GateResult } from "../queue/jobQueue";
import { parseJsonSafe } from "../lib/resultParser";
import { logger } from "../index";

/**
 * SonarQube gate -- runs sonar-scanner and queries the quality gate status.
 *
 * Expects the SonarQube server URL and token to be provided via environment
 * variables: `SONARQUBE_URL` and `SONARQUBE_TOKEN`.
 *
 * If SonarQube is not configured the gate is skipped gracefully.
 */
export async function runSonarQubeGate(
  vm: VMHandle,
  language: string,
  timeoutMs: number,
): Promise<GateResult> {
  const start = Date.now();

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

  // Generate a unique project key for this scan
  const projectKey = `arcagent-${vm.jobId}`;

  // 1. Run sonar-scanner inside the VM
  const scanCommand = buildScanCommand({
    sonarUrl,
    sonarToken,
    projectKey,
    language,
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
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ScanCommandOpts {
  sonarUrl: string;
  sonarToken: string;
  projectKey: string;
  language: string;
}

function buildScanCommand(opts: ScanCommandOpts): string {
  const args = [
    "sonar-scanner",
    `-Dsonar.host.url=${opts.sonarUrl}`,
    `-Dsonar.token=${opts.sonarToken}`,
    `-Dsonar.projectKey=${opts.projectKey}`,
    "-Dsonar.sources=.",
    "-Dsonar.qualitygate.wait=false", // We poll ourselves for better control
  ];

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
  }

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

    const result = await vm.exec(
      `curl -s -u "${sonarToken}:" "${sonarUrl}/api/qualitygates/project_status?projectKey=${projectKey}"`,
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
