import { describe, it, expect, vi } from "vitest";
import { mockVM, mockDiffContext, expectGatePass, expectGateFail } from "./__test-helpers__";

vi.mock("../index", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { runSecurityGate } from "./securityGate";

// Helper to build a VM that returns different results for different tool commands
function securityVM(options: {
  trivyOutput?: string;
  trivyExitCode?: number;
  semgrepOutput?: string;
  semgrepExitCode?: number;
  langSastOutput?: string;
  langSastExitCode?: number;
}) {
  return mockVM(async (cmd: string) => {
    if (cmd.includes("trivy")) {
      return {
        stdout: options.trivyOutput ?? '{"Results":[]}',
        stderr: "",
        exitCode: options.trivyExitCode ?? 0,
      };
    }
    if (cmd.includes("semgrep")) {
      return {
        stdout: options.semgrepOutput ?? '{"results":[]}',
        stderr: "",
        exitCode: options.semgrepExitCode ?? 0,
      };
    }
    // Language SAST or anything else
    return {
      stdout: options.langSastOutput ?? "{}",
      stderr: "",
      exitCode: options.langSastExitCode ?? 0,
    };
  });
}

describe("runSecurityGate", () => {
  it("No HIGH/CRITICAL findings -> 'pass'", async () => {
    const vm = securityVM({});
    const result = await runSecurityGate(vm, "typescript", 60_000, null);
    expectGatePass(result);
    expect(result.summary).toContain("passed");
  });

  it("HIGH severity Trivy finding -> 'fail'", async () => {
    const trivyOutput = JSON.stringify({
      Results: [{
        Target: "package.json",
        Vulnerabilities: [
          { VulnerabilityID: "CVE-2024-001", Severity: "HIGH", PkgName: "lodash" },
        ],
      }],
    });
    const vm = securityVM({ trivyOutput });
    const result = await runSecurityGate(vm, "typescript", 60_000, null);
    expectGateFail(result);
    expect(result.summary).toContain("1 high");
  });

  it("CRITICAL severity Semgrep finding -> 'fail'", async () => {
    const semgrepOutput = JSON.stringify({
      results: [{
        check_id: "sql-injection",
        path: "src/db.ts",
        start: { line: 10 },
        extra: { severity: "ERROR", message: "SQL injection" },
      }],
    });
    const vm = securityVM({ semgrepOutput });
    const result = await runSecurityGate(vm, "typescript", 60_000, null);
    expectGateFail(result);
    expect(result.summary).toContain("critical");
  });

  it("Diff-scoped: Semgrep findings filtered to changed lines", async () => {
    const semgrepOutput = JSON.stringify({
      results: [
        {
          check_id: "in-diff",
          path: "src/index.ts",
          start: { line: 25 },
          extra: { severity: "WARNING", message: "Issue in changed code" },
        },
        {
          check_id: "outside-diff",
          path: "src/other.ts",
          start: { line: 100 },
          extra: { severity: "WARNING", message: "Issue outside diff" },
        },
      ],
    });
    const diff = mockDiffContext({
      changedFiles: ["src/index.ts"],
      changedLineRanges: new Map([["src/index.ts", [[20, 30]]]]),
    });
    const vm = securityVM({ semgrepOutput });
    const result = await runSecurityGate(vm, "typescript", 60_000, diff);
    expectGateFail(result);
    // Only the in-diff finding should count
    expect((result.details as any).semgrep.findings).toHaveLength(1);
  });

  it("Trivy findings NOT filtered by diff (dependency-level)", async () => {
    const trivyOutput = JSON.stringify({
      Results: [{
        Target: "package-lock.json",
        Vulnerabilities: [
          { VulnerabilityID: "CVE-2024-001", Severity: "HIGH", PkgName: "axios" },
        ],
      }],
    });
    const diff = mockDiffContext({
      changedFiles: ["src/index.ts"],
      changedLineRanges: new Map([["src/index.ts", [[1, 10]]]]),
    });
    const vm = securityVM({ trivyOutput });
    const result = await runSecurityGate(vm, "typescript", 60_000, diff);
    expectGateFail(result);
    // Trivy finding should still be present even though it's not in diff
    expect((result.details as any).highCount).toBe(1);
  });

  it("Scanner failure returns error info but doesn't crash gate", async () => {
    const vm = securityVM({
      trivyOutput: "",
      trivyExitCode: 2,
      semgrepOutput: "",
      semgrepExitCode: 2,
    });
    const result = await runSecurityGate(vm, "typescript", 60_000, null);
    // Should still complete, just with 0 findings
    expect(result.gate).toBe("security");
    expect(result.status).toBe("pass"); // No HIGH/CRITICAL found
  });

  it("Multiple scanners: aggregates counts across all three", async () => {
    const trivyOutput = JSON.stringify({
      Results: [{
        Target: "package.json",
        Vulnerabilities: [
          { Severity: "HIGH", PkgName: "pkg1" },
        ],
      }],
    });
    const semgrepOutput = JSON.stringify({
      results: [{
        path: "src/a.ts",
        start: { line: 1 },
        extra: { severity: "WARNING" },
      }],
    });
    const vm = securityVM({ trivyOutput, semgrepOutput });
    const result = await runSecurityGate(vm, "typescript", 60_000, null);
    expectGateFail(result);
    expect((result.details as any).highCount).toBe(2); // 1 trivy + 1 semgrep
  });

  it("Low/medium findings only -> 'pass' with finding count in summary", async () => {
    const semgrepOutput = JSON.stringify({
      results: [{
        path: "src/a.ts",
        start: { line: 1 },
        extra: { severity: "INFO", message: "Low severity" },
      }],
    });
    const vm = securityVM({ semgrepOutput });
    const result = await runSecurityGate(vm, "typescript", 60_000, null);
    expectGatePass(result);
    expect(result.summary).toContain("finding(s)");
  });
});
