import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Job } from "bullmq";
import type { VerificationJobData, GateResult } from "../queue/jobQueue";
import type { VMHandle } from "../vm/firecracker";

// ---------------------------------------------------------------------------
// Mock all gate modules
// ---------------------------------------------------------------------------

vi.mock("./buildGate", () => ({ runBuildGate: vi.fn() }));
vi.mock("./lintGate", () => ({ runLintGate: vi.fn() }));
vi.mock("./typecheckGate", () => ({ runTypecheckGate: vi.fn() }));
vi.mock("./securityGate", () => ({ runSecurityGate: vi.fn() }));
vi.mock("./memoryGate", () => ({ runMemoryGate: vi.fn() }));
vi.mock("./snykGate", () => ({ runSnykGate: vi.fn() }));
vi.mock("./sonarqubeGate", () => ({ runSonarQubeGate: vi.fn() }));
vi.mock("./testGate", () => ({ runTestGate: vi.fn() }));
vi.mock("../index", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../vm/vmConfig", () => ({
  getVMConfig: vi.fn().mockReturnValue({ defaultGateTimeoutMs: 120000 }),
}));

// ---------------------------------------------------------------------------
// Import module under test and mocked gate functions
// ---------------------------------------------------------------------------

import { runGates } from "./gateRunner";
import { runBuildGate } from "./buildGate";
import { runLintGate } from "./lintGate";
import { runTypecheckGate } from "./typecheckGate";
import { runSecurityGate } from "./securityGate";
import { runMemoryGate } from "./memoryGate";
import { runSnykGate } from "./snykGate";
import { runSonarQubeGate } from "./sonarqubeGate";
import { runTestGate } from "./testGate";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePassResult(gateName: string): GateResult {
  return { gate: gateName, status: "pass", durationMs: 100, summary: "passed" };
}

function makeFailResult(gateName: string): GateResult {
  return { gate: gateName, status: "fail", durationMs: 50, summary: "failed" };
}

const ALL_GATE_NAMES = [
  "build",
  "lint",
  "typecheck",
  "security",
  "memory",
  "snyk",
  "sonarqube",
  "test",
];

/** Create a minimal mock VMHandle. */
function mockVM(): VMHandle {
  return {
    vmId: "test-vm",
    jobId: "test-job",
    guestIp: "192.168.0.2",
    exec: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
  };
}

/** Create a minimal mock BullMQ Job with sensible defaults. */
function mockJob(
  overrides: Partial<VerificationJobData> = {},
): Job<VerificationJobData> {
  return {
    data: {
      jobId: "test-job",
      submissionId: "sub-1",
      bountyId: "bounty-1",
      repoUrl: "https://github.com/owner/repo",
      commitSha: "abc1234",
      language: "typescript",
      timeoutSeconds: 600,
      ztacoMode: false,
      gateSettings: {},
      ...overrides,
    },
    updateProgress: vi.fn(),
  } as unknown as Job<VerificationJobData>;
}

function setAllGatesPass() {
  (runBuildGate as ReturnType<typeof vi.fn>).mockResolvedValue(makePassResult("build"));
  (runLintGate as ReturnType<typeof vi.fn>).mockResolvedValue(makePassResult("lint"));
  (runTypecheckGate as ReturnType<typeof vi.fn>).mockResolvedValue(makePassResult("typecheck"));
  (runSecurityGate as ReturnType<typeof vi.fn>).mockResolvedValue(makePassResult("security"));
  (runMemoryGate as ReturnType<typeof vi.fn>).mockResolvedValue(makePassResult("memory"));
  (runSnykGate as ReturnType<typeof vi.fn>).mockResolvedValue(makePassResult("snyk"));
  (runSonarQubeGate as ReturnType<typeof vi.fn>).mockResolvedValue(makePassResult("sonarqube"));
  (runTestGate as ReturnType<typeof vi.fn>).mockResolvedValue(makePassResult("test"));
}

// ---------------------------------------------------------------------------
// Reset mocks before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  setAllGatesPass();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runGates", () => {
  it("returns 8 results all pass when every gate passes", async () => {
    const results = await runGates(mockVM(), "typescript", mockJob(), null);

    expect(results).toHaveLength(8);
    for (const r of results) {
      expect(r.status).toBe("pass");
    }
    expect(results.map((r) => r.gate)).toEqual(ALL_GATE_NAMES);
  });

  it("build failure stops pipeline (fail-fast) -- remaining gates are skipped", async () => {
    (runBuildGate as ReturnType<typeof vi.fn>).mockResolvedValue(makeFailResult("build"));

    const results = await runGates(mockVM(), "typescript", mockJob(), null);

    expect(results).toHaveLength(8);
    expect(results[0]!.gate).toBe("build");
    expect(results[0]!.status).toBe("fail");

    // All subsequent gates should be skipped
    for (let i = 1; i < results.length; i++) {
      expect(results[i]!.status).toBe("skipped");
    }
  });

  it("lint failure does NOT stop pipeline (failFast: false)", async () => {
    (runLintGate as ReturnType<typeof vi.fn>).mockResolvedValue(makeFailResult("lint"));

    const results = await runGates(mockVM(), "typescript", mockJob(), null);

    expect(results).toHaveLength(8);
    expect(results[1]!.gate).toBe("lint");
    expect(results[1]!.status).toBe("fail");

    // Gates after lint should still run
    expect(results[2]!.status).toBe("pass"); // typecheck
    expect(results[7]!.status).toBe("pass"); // test
  });

  it("test failure stops pipeline (failFast: true)", async () => {
    (runTestGate as ReturnType<typeof vi.fn>).mockResolvedValue(makeFailResult("test"));

    const results = await runGates(mockVM(), "typescript", mockJob(), null);

    expect(results).toHaveLength(8);
    const testResult = results.find((r) => r.gate === "test");
    expect(testResult!.status).toBe("fail");

    // Test is last gate so no gates after it to skip, but verify non-test gates passed
    const nonTestResults = results.filter((r) => r.gate !== "test");
    for (const r of nonTestResults) {
      expect(r.status).toBe("pass");
    }
  });

  it("ZTACO mode: all gates run even after build failure", async () => {
    (runBuildGate as ReturnType<typeof vi.fn>).mockResolvedValue(makeFailResult("build"));

    const job = mockJob({ ztacoMode: true });
    const results = await runGates(mockVM(), "typescript", job, null);

    expect(results).toHaveLength(8);
    expect(results[0]!.status).toBe("fail"); // build
    // No gates are skipped in ZTACO mode
    const skippedCount = results.filter((r) => r.status === "skipped").length;
    expect(skippedCount).toBe(0);
  });

  it("disabled gates (snykEnabled=false) are skipped", async () => {
    const job = mockJob({ gateSettings: { snykEnabled: false } });
    const results = await runGates(mockVM(), "typescript", job, null);

    const snykResult = results.find((r) => r.gate === "snyk");
    expect(snykResult!.status).toBe("skipped");
    expect(snykResult!.summary).toContain("Snyk disabled");

    // The mocked gate function should not have been called
    expect(runSnykGate).not.toHaveBeenCalled();
  });

  it("disabled gates (sonarqubeEnabled=false) are skipped", async () => {
    const job = mockJob({ gateSettings: { sonarqubeEnabled: false } });
    const results = await runGates(mockVM(), "typescript", job, null);

    const sqResult = results.find((r) => r.gate === "sonarqube");
    expect(sqResult!.status).toBe("skipped");
    expect(sqResult!.summary).toContain("SonarQube disabled");

    expect(runSonarQubeGate).not.toHaveBeenCalled();
  });

  it("gate throwing exception results in error status recorded", async () => {
    (runBuildGate as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("VM crashed"),
    );

    const results = await runGates(mockVM(), "typescript", mockJob(), null);

    expect(results).toHaveLength(8);
    expect(results[0]!.gate).toBe("build");
    expect(results[0]!.status).toBe("error");
    expect(results[0]!.summary).toContain("VM crashed");

    // Build is fail-fast, so remaining gates should be skipped
    for (let i = 1; i < results.length; i++) {
      expect(results[i]!.status).toBe("skipped");
    }
  });

  it("calls job.updateProgress for each gate", async () => {
    const job = mockJob();
    await runGates(mockVM(), "typescript", job, null);

    // 8 gates = 8 progress updates
    expect(job.updateProgress).toHaveBeenCalledTimes(8);
  });
});
