import { describe, it, expect } from "vitest";
import { generateFeedback } from "./feedbackFormatter";
import type { GateResult } from "../queue/jobQueue";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGate(overrides: Partial<GateResult> & { gate: string }): GateResult {
  return {
    status: "pass",
    durationMs: 100,
    summary: `${overrides.gate} passed`,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// generateFeedback
// ---------------------------------------------------------------------------

describe("generateFeedback", () => {
  it("all gates pass -> overallStatus 'pass'", () => {
    const gates: GateResult[] = [
      makeGate({ gate: "build" }),
      makeGate({ gate: "lint" }),
      makeGate({ gate: "test" }),
    ];
    const feedback = generateFeedback(gates, 1);
    expect(feedback.overallStatus).toBe("pass");
  });

  it("one gate fails -> overallStatus 'fail'", () => {
    const gates: GateResult[] = [
      makeGate({ gate: "build" }),
      makeGate({ gate: "lint", status: "fail", summary: "3 lint errors" }),
      makeGate({ gate: "test" }),
    ];
    const feedback = generateFeedback(gates, 1);
    expect(feedback.overallStatus).toBe("fail");
  });

  it("one gate errors -> overallStatus 'error'", () => {
    const gates: GateResult[] = [
      makeGate({ gate: "build" }),
      makeGate({ gate: "lint", status: "error", summary: "Lint crashed" }),
    ];
    const feedback = generateFeedback(gates, 1);
    expect(feedback.overallStatus).toBe("error");
  });

  it("error takes precedence over fail", () => {
    const gates: GateResult[] = [
      makeGate({ gate: "build", status: "fail", summary: "Build failed" }),
      makeGate({ gate: "lint", status: "error", summary: "Lint crashed" }),
    ];
    const feedback = generateFeedback(gates, 1);
    expect(feedback.overallStatus).toBe("error");
  });

  it("attemptsRemaining = max(0, 5 - attemptNumber)", () => {
    expect(generateFeedback([], 1).attemptsRemaining).toBe(4);
    expect(generateFeedback([], 3).attemptsRemaining).toBe(2);
    expect(generateFeedback([], 5).attemptsRemaining).toBe(0);
    expect(generateFeedback([], 6).attemptsRemaining).toBe(0);
  });

  it("action items sorted by category priority (build before lint before test)", () => {
    const gates: GateResult[] = [
      makeGate({
        gate: "test",
        status: "fail",
        summary: "2 tests failed",
      }),
      makeGate({
        gate: "build",
        status: "fail",
        summary: "Build failed",
      }),
      makeGate({
        gate: "lint",
        status: "fail",
        summary: "Lint errors",
      }),
    ];
    const feedback = generateFeedback(gates, 1);
    expect(feedback.actionItems.length).toBeGreaterThanOrEqual(3);
    // Build (priority 0) should come before lint (2) which is before test (7)
    const buildIdx = feedback.actionItems.findIndex((a) => a.startsWith("[build]"));
    const lintIdx = feedback.actionItems.findIndex((a) => a.startsWith("[lint]"));
    const testIdx = feedback.actionItems.findIndex((a) => a.startsWith("[test]"));
    expect(buildIdx).toBeLessThan(lintIdx);
    expect(lintIdx).toBeLessThan(testIdx);
  });

  it("action items group issues by file", () => {
    const gates: GateResult[] = [
      makeGate({
        gate: "lint",
        status: "fail",
        summary: "4 lint errors",
        details: {
          normalizedIssues: [
            { severity: "error", category: "lint", file: "src/a.ts", message: "error 1" },
            { severity: "error", category: "lint", file: "src/a.ts", message: "error 2" },
            { severity: "warning", category: "lint", file: "src/b.ts", message: "warning 1" },
          ],
        },
      }),
    ];
    const feedback = generateFeedback(gates, 1);
    // Should have items grouped by file
    const aItem = feedback.actionItems.find((a) => a.includes("src/a.ts"));
    const bItem = feedback.actionItems.find((a) => a.includes("src/b.ts"));
    expect(aItem).toBeDefined();
    expect(bItem).toBeDefined();
    expect(aItem).toContain("2 error(s)");
    expect(bItem).toContain("1 warning(s)");
  });

  it("passed/skipped gates produce no action items", () => {
    const gates: GateResult[] = [
      makeGate({ gate: "build", status: "pass" }),
      makeGate({ gate: "lint", status: "skipped" as any, summary: "Skipped" }),
    ];
    const feedback = generateFeedback(gates, 1);
    expect(feedback.actionItems).toEqual([]);
  });

  it("collects test results from gate steps", () => {
    const gates: GateResult[] = [
      makeGate({
        gate: "test",
        steps: [
          {
            scenarioName: "Login works",
            featureName: "Auth",
            status: "pass",
            executionTimeMs: 100,
            stepNumber: 1,
            visibility: "public" as const,
          },
          {
            scenarioName: "Logout works",
            featureName: "Auth",
            status: "fail",
            executionTimeMs: 200,
            stepNumber: 2,
            visibility: "hidden" as const,
            output: "Expected 200, got 401",
          },
        ],
      }),
    ];
    const feedback = generateFeedback(gates, 1);
    expect(feedback.testResults).toHaveLength(2);
    expect(feedback.testResults[0]!.scenarioName).toBe("Login works");
    expect(feedback.testResults[1]!.visibility).toBe("hidden");
  });
});
