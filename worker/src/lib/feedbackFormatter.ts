/**
 * Structured feedback generation for ZTACO verification results.
 *
 * Converts raw gate results into a prioritized, actionable format that
 * AI agents can parse and act on to fix issues iteratively.
 */

import { GateResult, StepResult } from "../queue/jobQueue";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single normalized issue from any gate. */
export interface GateIssue {
  severity: "error" | "warning" | "info";
  category: string;
  file?: string;
  line?: number;
  column?: number;
  rule?: string;
  message: string;
  suggestion?: string;
}

/** Feedback for one gate. */
export interface GateFeedback {
  gate: string;
  status: string;
  summary: string;
  durationMs: number;
  issues: GateIssue[];
}

/** Feedback for a single test scenario. */
export interface TestFeedback {
  scenarioName: string;
  featureName: string;
  status: string;
  visibility: "public" | "hidden";
  output?: string;
}

export interface HiddenFailureMechanism {
  key:
    | "assertion_mismatch"
    | "runtime_exception"
    | "module_or_path_error"
    | "timeout_or_hang"
    | "permission_or_filesystem"
    | "api_contract_or_validation"
    | "unknown_edge_case";
  label: string;
  count: number;
  guidance: string;
}

/** Top-level structured feedback returned to agents. */
export interface VerificationFeedback {
  overallStatus: "pass" | "fail" | "error";
  attemptNumber: number;
  attemptsRemaining: number;
  gates: GateFeedback[];
  testResults: TestFeedback[];
  hiddenFailureMechanisms: HiddenFailureMechanism[];
  actionItems: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum submission attempts per bounty. */
const MAX_ATTEMPTS = 20;

/**
 * Priority order for action items. Build errors are most critical (code
 * won't compile), followed by type errors, lint, security, and tests.
 */
const CATEGORY_PRIORITY: Record<string, number> = {
  build: 0,
  typecheck: 1,
  lint: 2,
  security: 3,
  memory: 4,
  snyk: 5,
  sonarqube: 6,
  test: 7,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate structured feedback from raw gate results.
 */
export function generateFeedback(
  gateResults: GateResult[],
  attemptNumber: number,
): VerificationFeedback {
  const overallStatus = computeStatus(gateResults);

  const gates: GateFeedback[] = gateResults.map((g) => ({
    gate: g.gate,
    status: g.status,
    summary: g.summary,
    durationMs: g.durationMs,
    issues: g.details?.normalizedIssues as GateIssue[] ?? [],
  }));

  // Collect all test results (public + hidden). Hidden Gherkin remains
  // unreadable to agents, but verification feedback should be explicit.
  const testResults: TestFeedback[] = [];
  let hiddenFailures = 0;
  const hiddenFailureOutputs: string[] = [];
  for (const g of gateResults) {
    if (g.steps) {
      for (const step of g.steps) {
        const visibility = step.visibility ?? "public";
        if (step.visibility === "hidden") {
          if (step.status === "fail" || step.status === "error") {
            hiddenFailures += 1;
            if (step.output) hiddenFailureOutputs.push(step.output);
          }
        }
        testResults.push({
          scenarioName: step.scenarioName,
          featureName: step.featureName,
          status: step.status,
          visibility,
          output: step.output,
        });
      }
    }
  }

  const hiddenFailureMechanisms = summarizeHiddenFailureMechanisms(
    hiddenFailureOutputs,
    hiddenFailures,
  );

  // Build prioritized action items
  const actionItems = buildActionItems(
    gates,
    testResults,
    hiddenFailures,
    hiddenFailureMechanisms,
  );

  return {
    overallStatus,
    attemptNumber,
    attemptsRemaining: Math.max(0, MAX_ATTEMPTS - attemptNumber),
    gates,
    testResults,
    hiddenFailureMechanisms,
    actionItems,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function computeStatus(gates: GateResult[]): "pass" | "fail" | "error" {
  if (gates.some((g) => g.status === "error")) return "error";
  if (gates.some((g) => g.status === "fail")) return "fail";
  return "pass";
}

/**
 * Build a prioritized list of action items from gate feedback.
 * Items are ordered: build > typecheck > lint > security > test failures.
 */
function buildActionItems(
  gates: GateFeedback[],
  testResults: TestFeedback[],
  hiddenFailures: number,
  hiddenFailureMechanisms: HiddenFailureMechanism[],
): string[] {
  const items: { priority: number; text: string }[] = [];

  for (const gate of gates) {
    if (gate.status === "pass" || gate.status === "skipped") continue;

    const priority = CATEGORY_PRIORITY[gate.gate] ?? 99;

    if (gate.issues.length > 0) {
      // Group issues by file for concise reporting
      const byFile = new Map<string, GateIssue[]>();
      for (const issue of gate.issues) {
        const key = issue.file ?? "(unknown file)";
        const existing = byFile.get(key) ?? [];
        existing.push(issue);
        byFile.set(key, existing);
      }

      for (const [file, issues] of byFile) {
        const errorCount = issues.filter((i) => i.severity === "error").length;
        const warnCount = issues.filter((i) => i.severity === "warning").length;
        const parts: string[] = [];
        if (errorCount > 0) parts.push(`${errorCount} error(s)`);
        if (warnCount > 0) parts.push(`${warnCount} warning(s)`);
        items.push({
          priority,
          text: `[${gate.gate}] ${file}: ${parts.join(", ")} — ${issues[0].message}${issues.length > 1 ? ` (and ${issues.length - 1} more)` : ""}`,
        });
      }
    } else {
      // Gate failed but no structured issues — use summary
      items.push({
        priority,
        text: `[${gate.gate}] ${gate.summary}`,
      });
    }
  }

  // Add failed test scenarios
  const failedTests = testResults.filter((t) => t.status === "fail");
  if (failedTests.length > 0) {
    const priority = CATEGORY_PRIORITY["test"] ?? 99;
    for (const t of failedTests.slice(0, 20)) {
      items.push({
        priority,
        text: `[test] Scenario "${t.scenarioName}" (${t.featureName}, ${t.visibility}) failed${t.output ? `: ${t.output.slice(0, 200)}` : ""}`,
      });
    }
    if (failedTests.length > 20) {
      items.push({
        priority,
        text: `[test] ... and ${failedTests.length - 20} more failed scenarios`,
      });
    }
  }

  // Sort by priority
  items.sort((a, b) => a.priority - b.priority);

  return items.map((i) => i.text);
}

const HIDDEN_MECHANISM_METADATA: Record<HiddenFailureMechanism["key"], {
  label: string;
  guidance: string;
}> = {
  assertion_mismatch: {
    label: "Assertion mismatch",
    guidance: "Check edge-case outputs and strict equality assumptions.",
  },
  runtime_exception: {
    label: "Runtime exception",
    guidance: "Harden null/undefined handling and guard unsafe operations.",
  },
  module_or_path_error: {
    label: "Module or path error",
    guidance: "Verify import paths, file existence, and runtime entrypoints.",
  },
  timeout_or_hang: {
    label: "Timeout or hang",
    guidance: "Reduce algorithmic complexity and ensure async flows resolve.",
  },
  permission_or_filesystem: {
    label: "Permission or filesystem error",
    guidance: "Avoid privileged paths and handle file permissions safely.",
  },
  api_contract_or_validation: {
    label: "API contract or validation mismatch",
    guidance: "Validate request/response contracts and input validation branches.",
  },
  unknown_edge_case: {
    label: "Unknown edge case",
    guidance: "Add defensive checks around boundary conditions and error paths.",
  },
};

function summarizeHiddenFailureMechanisms(
  hiddenFailureOutputs: string[],
  hiddenFailures: number,
): HiddenFailureMechanism[] {
  if (hiddenFailures === 0) return [];

  const counts = new Map<HiddenFailureMechanism["key"], number>();
  for (const output of hiddenFailureOutputs) {
    const mechanism = classifyHiddenFailureOutput(output);
    counts.set(mechanism, (counts.get(mechanism) ?? 0) + 1);
  }

  const accounted = Array.from(counts.values()).reduce((sum, count) => sum + count, 0);
  const unknownCount = hiddenFailures - accounted;
  if (unknownCount > 0) {
    counts.set("unknown_edge_case", (counts.get("unknown_edge_case") ?? 0) + unknownCount);
  }

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => ({
      key,
      count,
      label: HIDDEN_MECHANISM_METADATA[key].label,
      guidance: HIDDEN_MECHANISM_METADATA[key].guidance,
    }));
}

function classifyHiddenFailureOutput(output: string): HiddenFailureMechanism["key"] {
  const normalized = output.toLowerCase();

  if (
    /expected .* to|to equal|to deeply equal|assert|expected .* got|mismatch/i.test(normalized)
  ) {
    return "assertion_mismatch";
  }
  if (
    /typeerror|referenceerror|syntaxerror|rangeerror|exception|panic|traceback|stack trace|segmentation fault/i.test(
      normalized,
    )
  ) {
    return "runtime_exception";
  }
  if (
    /cannot find module|module not found|no such file|enoent|importerror|cannot resolve/i.test(
      normalized,
    )
  ) {
    return "module_or_path_error";
  }
  if (/timeout|timed out|deadline exceeded|exceeded .*ms|hang/i.test(normalized)) {
    return "timeout_or_hang";
  }
  if (/eacces|eperm|permission denied|read-only file system|operation not permitted/i.test(normalized)) {
    return "permission_or_filesystem";
  }
  if (/validation|invalid input|schema|status code|http 4\d\d|unprocessable entity|bad request/i.test(normalized)) {
    return "api_contract_or_validation";
  }

  return "unknown_edge_case";
}
