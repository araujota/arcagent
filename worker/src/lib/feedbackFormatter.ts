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

/** Top-level structured feedback returned to agents. */
export interface VerificationFeedback {
  overallStatus: "pass" | "fail" | "error";
  attemptNumber: number;
  attemptsRemaining: number;
  gates: GateFeedback[];
  testResults: TestFeedback[];
  actionItems: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum submission attempts per bounty. */
const MAX_ATTEMPTS = 5;

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

  // Collect test results from test gate steps
  const testResults: TestFeedback[] = [];
  for (const g of gateResults) {
    if (g.steps) {
      for (const step of g.steps) {
        testResults.push({
          scenarioName: step.scenarioName,
          featureName: step.featureName,
          status: step.status,
          visibility: step.visibility,
          output: step.output,
        });
      }
    }
  }

  // Build prioritized action items
  const actionItems = buildActionItems(gates, testResults);

  return {
    overallStatus,
    attemptNumber,
    attemptsRemaining: Math.max(0, MAX_ATTEMPTS - attemptNumber),
    gates,
    testResults,
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
