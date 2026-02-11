import { VMHandle } from "../vm/firecracker";
import { GateResult } from "../queue/jobQueue";
import { parseJsonSafe } from "../lib/resultParser";

/**
 * Security gate -- runs Trivy (vulnerability scanner) and Semgrep (SAST).
 *
 * Both tools produce JSON output which is parsed to extract findings.
 * The gate fails if any HIGH or CRITICAL severity issues are found.
 */
export async function runSecurityGate(
  vm: VMHandle,
  language: string,
  timeoutMs: number,
): Promise<GateResult> {
  const start = Date.now();

  // Split timeout between the two scanners
  const scannerTimeout = Math.floor(timeoutMs / 2);

  // 1. Run Trivy filesystem scan
  const trivyResult = await runTrivy(vm, scannerTimeout);

  // 2. Run Semgrep SAST
  const semgrepResult = await runSemgrep(vm, language, scannerTimeout);

  const durationMs = Date.now() - start;

  // Aggregate findings
  const totalHigh =
    trivyResult.highCount + semgrepResult.highCount;
  const totalCritical =
    trivyResult.criticalCount + semgrepResult.criticalCount;
  const totalFindings =
    trivyResult.totalFindings + semgrepResult.totalFindings;

  const hasBlockingIssues = totalHigh > 0 || totalCritical > 0;

  return {
    gate: "security",
    status: hasBlockingIssues ? "fail" : "pass",
    durationMs,
    summary: hasBlockingIssues
      ? `Security scan found ${totalCritical} critical and ${totalHigh} high severity issue(s)`
      : `Security scan passed (${totalFindings} low/medium finding(s))`,
    details: {
      trivy: trivyResult,
      semgrep: semgrepResult,
      totalFindings,
      criticalCount: totalCritical,
      highCount: totalHigh,
    },
  };
}

// ---------------------------------------------------------------------------
// Trivy
// ---------------------------------------------------------------------------

interface ScanSummary {
  totalFindings: number;
  criticalCount: number;
  highCount: number;
  findings: unknown[];
  error?: string;
}

async function runTrivy(
  vm: VMHandle,
  timeoutMs: number,
): Promise<ScanSummary> {
  const result = await vm.exec(
    "cd /workspace && trivy fs --format json --severity HIGH,CRITICAL --scanners vuln,secret . 2>/dev/null",
    timeoutMs,
  );

  if (result.exitCode !== 0 && !result.stdout.trim()) {
    return {
      totalFindings: 0,
      criticalCount: 0,
      highCount: 0,
      findings: [],
      error: `Trivy exited with code ${result.exitCode}: ${truncate(result.stderr, 500)}`,
    };
  }

  const parsed = parseJsonSafe<TrivyReport>(result.stdout);

  if (!parsed || !parsed.Results) {
    return {
      totalFindings: 0,
      criticalCount: 0,
      highCount: 0,
      findings: [],
      error: "Failed to parse Trivy output",
    };
  }

  let criticalCount = 0;
  let highCount = 0;
  const findings: TrivyVulnerability[] = [];

  for (const target of parsed.Results) {
    for (const vuln of target.Vulnerabilities ?? []) {
      findings.push(vuln);
      if (vuln.Severity === "CRITICAL") criticalCount++;
      if (vuln.Severity === "HIGH") highCount++;
    }
  }

  return {
    totalFindings: findings.length,
    criticalCount,
    highCount,
    findings: findings.slice(0, 50), // Cap for payload size
  };
}

interface TrivyReport {
  Results?: TrivyTarget[];
}

interface TrivyTarget {
  Target?: string;
  Vulnerabilities?: TrivyVulnerability[];
}

interface TrivyVulnerability {
  VulnerabilityID?: string;
  PkgName?: string;
  Severity?: string;
  Title?: string;
}

// ---------------------------------------------------------------------------
// Semgrep
// ---------------------------------------------------------------------------

async function runSemgrep(
  vm: VMHandle,
  language: string,
  timeoutMs: number,
): Promise<ScanSummary> {
  const config = getSemgrepConfig(language);

  const result = await vm.exec(
    `cd /workspace && semgrep --config ${config} --json --quiet . 2>/dev/null`,
    timeoutMs,
  );

  if (result.exitCode !== 0 && !result.stdout.trim()) {
    return {
      totalFindings: 0,
      criticalCount: 0,
      highCount: 0,
      findings: [],
      error: `Semgrep exited with code ${result.exitCode}: ${truncate(result.stderr, 500)}`,
    };
  }

  const parsed = parseJsonSafe<SemgrepReport>(result.stdout);

  if (!parsed || !parsed.results) {
    return {
      totalFindings: 0,
      criticalCount: 0,
      highCount: 0,
      findings: [],
      error: "Failed to parse Semgrep output",
    };
  }

  let criticalCount = 0;
  let highCount = 0;

  for (const finding of parsed.results) {
    const severity = finding.extra?.severity?.toUpperCase();
    if (severity === "ERROR" || severity === "CRITICAL") criticalCount++;
    if (severity === "WARNING" || severity === "HIGH") highCount++;
  }

  return {
    totalFindings: parsed.results.length,
    criticalCount,
    highCount,
    findings: parsed.results.slice(0, 50),
  };
}

interface SemgrepReport {
  results?: SemgrepFinding[];
}

interface SemgrepFinding {
  check_id?: string;
  path?: string;
  extra?: {
    severity?: string;
    message?: string;
  };
}

function getSemgrepConfig(language: string): string {
  switch (language.toLowerCase()) {
    case "typescript":
    case "javascript":
      return "p/javascript";
    case "python":
      return "p/python";
    case "go":
      return "p/golang";
    case "rust":
      return "p/rust";
    case "java":
      return "p/java";
    default:
      return "p/default";
  }
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "\n... (truncated)";
}
