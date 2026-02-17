import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Job } from "bullmq";
import type { VerificationJobData, VerificationResult, GateResult } from "./jobQueue";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../index", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockCreateVM = vi.fn();
const mockDestroyVM = vi.fn();
vi.mock("../vm/firecracker", () => ({
  createFirecrackerVM: (...args: unknown[]) => mockCreateVM(...args),
  destroyFirecrackerVM: (...args: unknown[]) => mockDestroyVM(...args),
}));

const mockRunGates = vi.fn();
vi.mock("../gates/gateRunner", () => ({
  runGates: (...args: unknown[]) => mockRunGates(...args),
}));

const mockPostResult = vi.fn();
vi.mock("../convex/client", () => ({
  postVerificationResult: (...args: unknown[]) => mockPostResult(...args),
}));

const mockDetectLanguage = vi.fn().mockResolvedValue("typescript");
vi.mock("../lib/languageDetector", () => ({
  detectLanguage: (...args: unknown[]) => mockDetectLanguage(...args),
}));

vi.mock("../vm/vmConfig", () => ({
  getVMConfig: vi.fn().mockReturnValue({
    rootfsImage: "test.ext4",
    vcpuCount: 2,
    memSizeMib: 512,
  }),
}));

const mockSanitize = vi.fn((val: string) => val);
const mockValidate = vi.fn();
vi.mock("../lib/shellSanitize", () => ({
  sanitizeShellArg: (...args: unknown[]) => mockSanitize(...args),
  validateShellArg: (...args: unknown[]) => mockValidate(...args),
}));

const mockComputeDiff = vi.fn().mockResolvedValue(null);
vi.mock("../lib/diffComputer", () => ({
  computeDiff: (...args: unknown[]) => mockComputeDiff(...args),
}));

const mockGenerateFeedback = vi.fn().mockReturnValue({ gates: [], summary: "ok" });
vi.mock("../lib/feedbackFormatter", () => ({
  generateFeedback: (...args: unknown[]) => mockGenerateFeedback(...args),
}));

// ---------------------------------------------------------------------------
// Import module under test
// ---------------------------------------------------------------------------

import { processVerificationJob, processVerificationFromDiff } from "./jobProcessor";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockJob(overrides: Partial<VerificationJobData> = {}): Job<VerificationJobData, VerificationResult> {
  return {
    data: {
      jobId: "job_123",
      submissionId: "sub_456",
      bountyId: "bounty_789",
      repoUrl: "https://github.com/test/repo",
      commitSha: "abc1234",
      timeoutSeconds: 600,
      convexUrl: "https://test.convex.cloud",
      ...overrides,
    },
    updateProgress: vi.fn(),
  } as unknown as Job<VerificationJobData, VerificationResult>;
}

function mockVM() {
  return {
    vmId: "vm_test_123",
    exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" }),
    writeFile: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
  };
}

const PASS_GATE: GateResult = {
  gate: "build",
  status: "pass",
  durationMs: 100,
  summary: "Build passed",
};

const FAIL_GATE: GateResult = {
  gate: "test",
  status: "fail",
  durationMs: 200,
  summary: "Tests failed",
};

const ERROR_GATE: GateResult = {
  gate: "lint",
  status: "error",
  durationMs: 50,
  summary: "Lint errored",
};

const WARNING_GATE: GateResult = {
  gate: "security",
  status: "warning" as GateResult["status"],
  durationMs: 80,
  summary: "Security warnings",
};

const SKIPPED_GATE: GateResult = {
  gate: "snyk",
  status: "skipped" as GateResult["status"],
  durationMs: 0,
  summary: "Snyk skipped",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("processVerificationJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const vm = mockVM();
    mockCreateVM.mockResolvedValue(vm);
    mockDestroyVM.mockResolvedValue(undefined);
    mockRunGates.mockResolvedValue([PASS_GATE]);
    mockPostResult.mockResolvedValue(undefined);
  });

  it("happy path: creates VM, runs gates, posts result, destroys VM", async () => {
    const job = mockJob();
    const vm = mockVM();
    mockCreateVM.mockResolvedValue(vm);

    const result = await processVerificationJob(job);

    expect(mockCreateVM).toHaveBeenCalledOnce();
    expect(mockRunGates).toHaveBeenCalledOnce();
    expect(mockPostResult).toHaveBeenCalledWith("https://test.convex.cloud", expect.objectContaining({
      jobId: "job_123",
      overallStatus: "pass",
    }));
    expect(mockDestroyVM).toHaveBeenCalledWith(vm);
    expect(result.overallStatus).toBe("pass");
  });

  it("shell sanitization called for repoUrl and commitSha", async () => {
    const job = mockJob();
    await processVerificationJob(job);

    expect(mockSanitize).toHaveBeenCalledWith("https://github.com/test/repo", "repoUrl", "repoUrl");
    expect(mockSanitize).toHaveBeenCalledWith("abc1234", "commitSha", "commitSha");
  });

  it("baseCommitSha present → deep clone (no --depth 1)", async () => {
    const vm = mockVM();
    mockCreateVM.mockResolvedValue(vm);
    const job = mockJob({ baseCommitSha: "base123" });

    await processVerificationJob(job);

    // The clone command should NOT contain --depth 1
    const cloneCall = vm.exec.mock.calls[0][0] as string;
    expect(cloneCall).not.toContain("--depth 1");
  });

  it("baseCommitSha absent → shallow clone (--depth 1)", async () => {
    const vm = mockVM();
    mockCreateVM.mockResolvedValue(vm);
    const job = mockJob(); // no baseCommitSha

    await processVerificationJob(job);

    const cloneCall = vm.exec.mock.calls[0][0] as string;
    expect(cloneCall).toContain("--depth 1");
  });

  it("gate pipeline throws → overallStatus: 'error', VM destroyed, error result posted", async () => {
    const vm = mockVM();
    mockCreateVM.mockResolvedValue(vm);
    mockRunGates.mockRejectedValue(new Error("gate explosion"));

    await expect(processVerificationJob(mockJob())).rejects.toThrow("gate explosion");

    expect(mockPostResult).toHaveBeenCalledWith("https://test.convex.cloud", expect.objectContaining({
      overallStatus: "error",
    }));
    expect(mockDestroyVM).toHaveBeenCalledWith(vm);
  });

  it("VM creation fails → no destroyFirecrackerVM call (vm is null)", async () => {
    mockCreateVM.mockRejectedValue(new Error("VM creation failed"));

    await expect(processVerificationJob(mockJob())).rejects.toThrow("VM creation failed");

    expect(mockDestroyVM).not.toHaveBeenCalled();
  });

  it("postVerificationResult failure doesn't crash job", async () => {
    const vm = mockVM();
    mockCreateVM.mockResolvedValue(vm);
    mockPostResult.mockRejectedValue(new Error("network error"));

    // Should NOT throw even though postResult fails
    const result = await processVerificationJob(mockJob());
    expect(result.overallStatus).toBe("pass");
  });

  it("ZTACO mode → uses computeOverallStatusZtaco logic", async () => {
    const vm = mockVM();
    mockCreateVM.mockResolvedValue(vm);
    // With skipped + pass gates, ztaco should pass (skipped filtered out)
    mockRunGates.mockResolvedValue([PASS_GATE, SKIPPED_GATE]);

    const job = mockJob({ ztacoMode: true });
    const result = await processVerificationJob(job);

    expect(result.overallStatus).toBe("pass");
  });

  it("no convexUrl → skips posting result", async () => {
    const vm = mockVM();
    mockCreateVM.mockResolvedValue(vm);
    const job = mockJob({ convexUrl: undefined });

    await processVerificationJob(job);

    expect(mockPostResult).not.toHaveBeenCalled();
  });
});

describe("processVerificationFromDiff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const vm = mockVM();
    mockCreateVM.mockResolvedValue(vm);
    mockDestroyVM.mockResolvedValue(undefined);
    mockRunGates.mockResolvedValue([PASS_GATE]);
    mockPostResult.mockResolvedValue(undefined);
  });

  it("missing diffPatch → throws immediately", async () => {
    const job = mockJob({ diffPatch: undefined });

    await expect(processVerificationFromDiff(job)).rejects.toThrow(
      "diffPatch is required",
    );
  });

  it("patch apply fails (exitCode !== 0) → returns patch-apply gate, posts result", async () => {
    const vm = mockVM();
    vm.exec.mockImplementation(async (cmd: string) => {
      if (cmd.includes("git apply")) {
        return { exitCode: 1, stdout: "", stderr: "patch failed" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    mockCreateVM.mockResolvedValue(vm);

    const job = mockJob({ diffPatch: "diff --git a/file.ts b/file.ts\n..." });
    const result = await processVerificationFromDiff(job);

    expect(result.overallStatus).toBe("fail");
    expect(result.gates).toHaveLength(1);
    expect(result.gates[0].gate).toBe("patch-apply");
    expect(mockRunGates).not.toHaveBeenCalled();
  });

  it("patch apply succeeds → full gate pipeline runs", async () => {
    const vm = mockVM();
    vm.exec.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    mockCreateVM.mockResolvedValue(vm);

    const job = mockJob({ diffPatch: "diff --git a/file.ts b/file.ts\n..." });
    const result = await processVerificationFromDiff(job);

    expect(result.overallStatus).toBe("pass");
    expect(mockRunGates).toHaveBeenCalledOnce();
  });

  it("VM destroyed in finally even after patch failure", async () => {
    const vm = mockVM();
    vm.exec.mockImplementation(async (cmd: string) => {
      if (cmd.includes("git apply")) {
        return { exitCode: 128, stdout: "", stderr: "fatal" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    mockCreateVM.mockResolvedValue(vm);

    const job = mockJob({ diffPatch: "diff --git a/file.ts b/file.ts\n..." });
    await processVerificationFromDiff(job);

    expect(mockDestroyVM).toHaveBeenCalledWith(vm);
  });

  it("missing vm.writeFile → throws", async () => {
    const vm = mockVM();
    (vm as any).writeFile = undefined;
    mockCreateVM.mockResolvedValue(vm);

    const job = mockJob({ diffPatch: "diff --git a/file.ts b/file.ts\n..." });
    await expect(processVerificationFromDiff(job)).rejects.toThrow(
      "VM does not support writeFile",
    );
  });
});

describe("computeOverallStatus (via processVerificationJob)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const vm = mockVM();
    mockCreateVM.mockResolvedValue(vm);
    mockDestroyVM.mockResolvedValue(undefined);
    mockPostResult.mockResolvedValue(undefined);
  });

  it("all gates pass → 'pass'", async () => {
    mockRunGates.mockResolvedValue([PASS_GATE, PASS_GATE]);
    const result = await processVerificationJob(mockJob());
    expect(result.overallStatus).toBe("pass");
  });

  it("one gate fail → 'fail'", async () => {
    mockRunGates.mockResolvedValue([PASS_GATE, FAIL_GATE]);
    const result = await processVerificationJob(mockJob());
    expect(result.overallStatus).toBe("fail");
  });

  it("one gate error → 'error' (takes priority over fail)", async () => {
    mockRunGates.mockResolvedValue([FAIL_GATE, ERROR_GATE]);
    const result = await processVerificationJob(mockJob());
    expect(result.overallStatus).toBe("error");
  });

  it("gates with warning and skipped only → 'pass'", async () => {
    mockRunGates.mockResolvedValue([WARNING_GATE, SKIPPED_GATE]);
    const result = await processVerificationJob(mockJob());
    expect(result.overallStatus).toBe("pass");
  });
});

describe("computeOverallStatusZtaco (via processVerificationJob ztacoMode)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const vm = mockVM();
    mockCreateVM.mockResolvedValue(vm);
    mockDestroyVM.mockResolvedValue(undefined);
    mockPostResult.mockResolvedValue(undefined);
  });

  it("all pass + one skipped → 'pass'", async () => {
    mockRunGates.mockResolvedValue([PASS_GATE, SKIPPED_GATE]);
    const result = await processVerificationJob(mockJob({ ztacoMode: true }));
    expect(result.overallStatus).toBe("pass");
  });

  it("non-skipped fail → 'fail'", async () => {
    mockRunGates.mockResolvedValue([PASS_GATE, FAIL_GATE, SKIPPED_GATE]);
    const result = await processVerificationJob(mockJob({ ztacoMode: true }));
    expect(result.overallStatus).toBe("fail");
  });

  it("all skipped → 'pass'", async () => {
    mockRunGates.mockResolvedValue([SKIPPED_GATE, SKIPPED_GATE]);
    const result = await processVerificationJob(mockJob({ ztacoMode: true }));
    expect(result.overallStatus).toBe("pass");
  });
});
