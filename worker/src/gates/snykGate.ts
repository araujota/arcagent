import { VMHandle } from "../vm/firecracker";
import { GateResult } from "../queue/jobQueue";
import { DiffContext } from "../lib/diffContext";
import { parseJsonSafe } from "../lib/resultParser";

/**
 * Snyk gate — runs SCA (dependency vulnerability) and SAST (Snyk Code) scans.
 *
 * Skipped if `SNYK_TOKEN` is not configured. Runs on the full project (SCA is
 * inherently project-wide — the agent may have added a vulnerable dependency).
 *
 * Non-fail-fast: HIGH/CRITICAL findings fail the gate but don't abort the pipeline.
 */
export async function runSnykGate(
  vm: VMHandle,
  language: string,
  timeoutMs: number,
  _diff: DiffContext | null,
): Promise<GateResult> {
  const start = Date.now();

  const snykToken = process.env.SNYK_TOKEN;
  if (!snykToken) {
    return {
      gate: "snyk",
      status: "skipped",
      durationMs: Date.now() - start,
      summary: "Snyk not configured (SNYK_TOKEN missing)",
    };
  }

  const scannerTimeout = Math.floor(timeoutMs / 2);

  // 1. SCA scan — dependency vulnerabilities
  const scaResult = await runSnykTest(vm, snykToken, scannerTimeout);

  // 2. SAST scan — Snyk Code
  const sastResult = await runSnykCode(vm, snykToken, scannerTimeout);

  const durationMs = Date.now() - start;

  const totalHigh = scaResult.highCount + sastResult.highCount;
  const totalCritical = scaResult.criticalCount + sastResult.criticalCount;
  const totalFindings = scaResult.totalFindings + sastResult.totalFindings;
  const hasBlockingIssues = totalHigh > 0 || totalCritical > 0;

  return {
    gate: "snyk",
    status: hasBlockingIssues ? "fail" : "pass",
    durationMs,
    summary: hasBlockingIssues
      ? `Snyk found ${totalCritical} critical and ${totalHigh} high severity issue(s)`
      : `Snyk scan passed (${totalFindings} low/medium finding(s))`,
    details: {
      sca: scaResult,
      sast: sastResult,
      totalFindings,
      criticalCount: totalCritical,
      highCount: totalHigh,
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SnykScanSummary {
  totalFindings: number;
  criticalCount: number;
  highCount: number;
  error?: string;
}

async function runSnykTest(
  vm: VMHandle,
  token: string,
  timeoutMs: number,
): Promise<SnykScanSummary> {
  // SECURITY (H5): Write token to a root-only file so agent code cannot
  // read it from /proc/self/environ. The token is sourced only by the
  // scanner subprocess and the file is deleted immediately after.
  const result = await vm.exec(
    `cd /workspace && ` +
    `printf '%s' '${token.replace(/'/g, "'\\''")}' > /tmp/.snyk_token && chmod 600 /tmp/.snyk_token && ` +
    `SNYK_TOKEN=$(cat /tmp/.snyk_token) snyk test --json --severity-threshold=high 2>/dev/null; ` +
    `ST=$?; rm -f /tmp/.snyk_token; exit $ST`,
    timeoutMs,
  );

  // Snyk exits with 1 when vulnerabilities are found, 0 when clean
  if (!result.stdout.trim()) {
    return {
      totalFindings: 0,
      criticalCount: 0,
      highCount: 0,
      error: result.exitCode !== 0
        ? `Snyk test exited with code ${result.exitCode}`
        : undefined,
    };
  }

  const parsed = parseJsonSafe<SnykTestOutput>(result.stdout);
  if (!parsed) {
    return {
      totalFindings: 0,
      criticalCount: 0,
      highCount: 0,
      error: "Failed to parse Snyk test output",
    };
  }

  let criticalCount = 0;
  let highCount = 0;
  const vulns = parsed.vulnerabilities ?? [];

  for (const v of vulns) {
    const severity = v.severity?.toUpperCase();
    if (severity === "CRITICAL") criticalCount++;
    if (severity === "HIGH") highCount++;
  }

  return {
    totalFindings: vulns.length,
    criticalCount,
    highCount,
  };
}

async function runSnykCode(
  vm: VMHandle,
  token: string,
  timeoutMs: number,
): Promise<SnykScanSummary> {
  // SECURITY (H5): Same token isolation as runSnykTest
  const result = await vm.exec(
    `cd /workspace && ` +
    `printf '%s' '${token.replace(/'/g, "'\\''")}' > /tmp/.snyk_token && chmod 600 /tmp/.snyk_token && ` +
    `SNYK_TOKEN=$(cat /tmp/.snyk_token) snyk code test --json --severity-threshold=high 2>/dev/null; ` +
    `ST=$?; rm -f /tmp/.snyk_token; exit $ST`,
    timeoutMs,
  );

  if (!result.stdout.trim()) {
    return {
      totalFindings: 0,
      criticalCount: 0,
      highCount: 0,
      error: result.exitCode !== 0
        ? `Snyk code test exited with code ${result.exitCode}`
        : undefined,
    };
  }

  const parsed = parseJsonSafe<SnykCodeOutput>(result.stdout);
  if (!parsed) {
    return {
      totalFindings: 0,
      criticalCount: 0,
      highCount: 0,
      error: "Failed to parse Snyk Code output",
    };
  }

  let criticalCount = 0;
  let highCount = 0;
  const runs = parsed.runs ?? [];

  for (const run of runs) {
    for (const finding of run.results ?? []) {
      const level = finding.level?.toUpperCase();
      if (level === "ERROR") criticalCount++;
      if (level === "WARNING") highCount++;
    }
  }

  const totalFindings = runs.reduce(
    (sum, run) => sum + (run.results?.length ?? 0),
    0,
  );

  return {
    totalFindings,
    criticalCount,
    highCount,
  };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SnykTestOutput {
  vulnerabilities?: {
    id?: string;
    severity?: string;
    title?: string;
    packageName?: string;
  }[];
}

interface SnykCodeOutput {
  runs?: {
    results?: {
      ruleId?: string;
      level?: string;
      message?: { text?: string };
    }[];
  }[];
}
