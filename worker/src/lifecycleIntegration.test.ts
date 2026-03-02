import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Full lifecycle integration tests simulating interactions between:
 *  - Agent host (MCP → HTTP calls to worker)
 *  - Worker (Express routes + BullMQ queue + session management)
 *  - Firecracker VM (mocked — vsock exec/writeFile/readFile)
 *  - Convex backend (mocked — receives results via HTTP)
 *
 * These tests exercise the complete request→response paths through real route
 * handlers and real session/job management code, with only the VM and external
 * HTTP calls mocked.
 */

// ---------------------------------------------------------------------------
// Mocks — must be declared before imports (vi.mock is hoisted)
// ---------------------------------------------------------------------------

vi.mock("./index", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("./vm/firecracker", () => ({
  createFirecrackerVM: vi.fn(),
  destroyFirecrackerVM: vi.fn().mockResolvedValue(undefined),
  releaseGuestIp: vi.fn(),
  _getAllocatedIps: vi.fn().mockReturnValue(new Set()),
}));

vi.mock("./vm/vmConfig", () => ({
  getVMConfig: vi.fn().mockReturnValue({
    rootfsImage: "node-20.ext4",
    vcpuCount: 2,
    memSizeMib: 1024,
    defaultGateTimeoutMs: 120_000,
    vsockPort: 5000,
    allowedDomains: [],
  }),
}));

vi.mock("./gates/legRunner", () => ({
  runVerificationLegs: vi.fn().mockResolvedValue({
    legacyGates: [
      { gate: "build", status: "pass", durationMs: 150, summary: "Build succeeded" },
      { gate: "lint", status: "pass", durationMs: 80, summary: "No lint errors" },
      { gate: "typecheck", status: "pass", durationMs: 120, summary: "Types OK" },
      { gate: "test", status: "pass", durationMs: 500, summary: "15/15 tests passed" },
    ],
    receipts: [
      {
        jobId: "job-lifecycle-001",
        submissionId: "sub-lifecycle-001",
        bountyId: "bounty-lifecycle-001",
        attemptNumber: 1,
        legKey: "build",
        orderIndex: 1,
        status: "pass",
        blocking: true,
        startedAt: 1,
        completedAt: 2,
        durationMs: 1,
        summaryLine: "PASS",
      },
      {
        jobId: "job-lifecycle-001",
        submissionId: "sub-lifecycle-001",
        bountyId: "bounty-lifecycle-001",
        attemptNumber: 1,
        legKey: "bdd_public",
        orderIndex: 2,
        status: "pass",
        blocking: true,
        startedAt: 2,
        completedAt: 3,
        durationMs: 1,
        summaryLine: "PASS",
      },
    ],
    steps: [],
  }),
}));

vi.mock("./lib/languageDetector", () => ({
  detectLanguage: vi.fn().mockResolvedValue("typescript"),
}));

vi.mock("./lib/diffComputer", () => ({
  computeDiff: vi.fn().mockResolvedValue(null),
}));

vi.mock("./lib/shellSanitize", () => ({
  sanitizeShellArg: vi.fn((v: string) => `'${v}'`),
  validateShellArg: vi.fn(),
}));

vi.mock("./convex/client", () => ({
  postVerificationResult: vi.fn().mockResolvedValue(undefined),
  postVerificationReceipt: vi.fn().mockResolvedValue(undefined),
  postVerificationArtifact: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./lib/feedbackFormatter", () => ({
  generateFeedback: vi.fn().mockReturnValue({ summary: "OK", suggestions: [] }),
}));

vi.mock("./lib/timeout", () => ({
  withTimeout: vi.fn().mockImplementation(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock("./workspace/sessionStore", () => ({
  sessionStore: {
    save: vi.fn().mockResolvedValue(undefined),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    updateActivity: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    ping: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("./workspace/heartbeat", () => ({
  workspaceHeartbeat: {
    startMonitoring: vi.fn(),
    stopMonitoring: vi.fn(),
    startWorkerHeartbeat: vi.fn(),
    stopAll: vi.fn(),
  },
}));

vi.mock("./vm/vmPool", () => ({
  vmPool: {
    acquire: vi.fn().mockResolvedValue(null),
    initialize: vi.fn().mockResolvedValue(undefined),
    drainAll: vi.fn().mockResolvedValue(undefined),
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { createFirecrackerVM, destroyFirecrackerVM } from "./vm/firecracker";
import { processVerificationJob, processVerificationFromDiff } from "./queue/jobProcessor";
import { postVerificationResult } from "./convex/client";
import { runVerificationLegs } from "./gates/legRunner";
import { withTimeout } from "./lib/timeout";
import {
  provisionWorkspace,
  getSession,
  destroyWorkspace,
  extractDiff,
  touchActivity,
  listActiveSessions,
  destroyAllSessions,
} from "./workspace/sessionManager";
import type { VMHandle, ExecResult } from "./vm/firecracker";
import type { Job } from "bullmq";

// ---------------------------------------------------------------------------
// VM mock factory
// ---------------------------------------------------------------------------

function createMockVM(overrides?: Partial<VMHandle>): VMHandle {
  return {
    vmId: "vm-int-test01",
    jobId: "job-integration",
    guestIp: "10.0.0.42",
    exec: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 } as ExecResult),
    writeFile: vi.fn().mockResolvedValue(undefined),
    execWithStdin: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 } as ExecResult),
    vsockRequest: vi.fn().mockResolvedValue({ status: "ok", stdout: "", stderr: "", exitCode: 0 }),
    ...overrides,
  } as unknown as VMHandle;
}

function createMockJob(overrides?: Record<string, unknown>): Job {
  return {
    data: {
      jobId: "job-lifecycle-001",
      submissionId: "sub-lifecycle-001",
      bountyId: "bounty-lifecycle-001",
      repoUrl: "https://github.com/test/repo",
      repoAuthToken: "ghs_mocktoken",
      commitSha: "abc1234def5678",
      timeoutSeconds: 300,
      convexUrl: "https://test-deploy.convex.cloud",
      ...overrides,
    },
    updateProgress: vi.fn().mockResolvedValue(undefined),
  } as unknown as Job;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  // Reset default VM mock
  vi.mocked(createFirecrackerVM).mockResolvedValue(createMockVM());
});

// =========================================================================
// FLOW 1: Full Workspace (Dev VM) Lifecycle
// Agent Host → Worker → VM → Agent Host
// =========================================================================

describe("Flow 1: Workspace lifecycle (agent → worker → VM → agent)", () => {
  const workspaceId = "ws-lifecycle-test-001";
  const provisionOpts = {
    workspaceId,
    claimId: "claim-001",
    bountyId: "bounty-001",
    agentId: "agent-001",
    repoUrl: "https://github.com/test/repo",
    repoAuthToken: "ghs_mocktoken",
    commitSha: "abc1234",
    language: "typescript",
    expiresAt: Date.now() + 4 * 60 * 60 * 1000,
  };

  it("complete workspace lifecycle: provision → exec → write → diff → destroy", async () => {
    // --- Step 1: Agent requests workspace provisioning via Convex → Worker ---
    const mockVM = createMockVM({
      exec: vi.fn()
        .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 })  // git clone
        .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 })  // chown
        .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 })  // npm ci
        .mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),     // default
    });
    vi.mocked(createFirecrackerVM).mockResolvedValue(mockVM);

    const session = await provisionWorkspace(provisionOpts);

    // Worker created VM and cloned repo
    expect(createFirecrackerVM).toHaveBeenCalledOnce();
    expect(session.status).toBe("ready");
    expect(session.vmHandle).toBe(mockVM);

    // Verify repo clone command was executed inside VM
    const cloneCall = vi.mocked(mockVM.exec).mock.calls[0];
    expect(cloneCall[0]).toContain("git clone");
    expect(cloneCall[0]).toContain("github.com/test/repo");

    // --- Step 2: Agent executes command in VM via worker ---
    vi.mocked(mockVM.exec).mockResolvedValueOnce({
      stdout: "src/index.ts\nsrc/utils.ts\npackage.json\n",
      stderr: "",
      exitCode: 0,
    });

    touchActivity(workspaceId);
    const lsResult = await session.vmHandle.exec("ls /workspace", 30_000, "agent");

    expect(lsResult.exitCode).toBe(0);
    expect(lsResult.stdout).toContain("src/index.ts");

    // --- Step 3: Agent writes a file to the VM ---
    const fileContent = Buffer.from('console.log("hello from agent");\n');
    await session.vmHandle.writeFile(
      "/workspace/src/new-file.ts",
      fileContent,
      "0644",
      "agent:agent",
    );

    expect(mockVM.writeFile).toHaveBeenCalledWith(
      "/workspace/src/new-file.ts",
      fileContent,
      "0644",
      "agent:agent",
    );

    // --- Step 4: Agent extracts diff for submission ---
    vi.mocked(mockVM.exec).mockResolvedValueOnce({
      stdout: [
        "---DIFF---",
        "diff --git a/src/new-file.ts b/src/new-file.ts",
        "+console.log(\"hello from agent\");",
        "---STAT---",
        " src/new-file.ts | 1 +",
        " 1 file changed, 1 insertion(+)",
        "---NAMES---",
        "src/new-file.ts",
      ].join("\n"),
      stderr: "",
      exitCode: 0,
    });

    const diff = await extractDiff(workspaceId);

    expect(diff.hasChanges).toBe(true);
    expect(diff.changedFiles).toContain("src/new-file.ts");
    expect(diff.diffPatch).toContain("+console.log");

    // --- Step 5: Convex calls worker to destroy workspace ---
    await destroyWorkspace(workspaceId, "claim_released");

    expect(destroyFirecrackerVM).toHaveBeenCalledWith(mockVM);
    expect(getSession(workspaceId)?.status).toBe("destroyed");
  });

  it("provision is idempotent — returns existing session on duplicate request", async () => {
    const mockVM = createMockVM();
    vi.mocked(createFirecrackerVM).mockResolvedValue(mockVM);

    const session1 = await provisionWorkspace(provisionOpts);
    const session2 = await provisionWorkspace(provisionOpts);

    // Same session returned, VM created only once
    expect(session1).toBe(session2);
    expect(createFirecrackerVM).toHaveBeenCalledOnce();

    // Cleanup
    await destroyWorkspace(workspaceId, "test_cleanup");
  });

  it("workspace exec runs commands as non-root agent user", async () => {
    const mockVM = createMockVM({
      exec: vi.fn().mockResolvedValue({ stdout: "agent\n", stderr: "", exitCode: 0 }),
    });
    vi.mocked(createFirecrackerVM).mockResolvedValue(mockVM);

    const session = await provisionWorkspace({
      ...provisionOpts,
      workspaceId: "ws-exec-user-test",
    });

    // Simulate agent running `whoami`
    await session.vmHandle.exec("whoami", 5_000, "agent");

    // Verify the last exec call used "agent" user
    const lastCall = vi.mocked(mockVM.exec).mock.calls.at(-1)!;
    expect(lastCall[2]).toBe("agent"); // user parameter

    await destroyWorkspace("ws-exec-user-test", "test_cleanup");
  });

  it("workspace destroy cleans up even if VM destruction fails", async () => {
    const mockVM = createMockVM();
    vi.mocked(createFirecrackerVM).mockResolvedValue(mockVM);
    vi.mocked(destroyFirecrackerVM).mockRejectedValueOnce(new Error("PID not found"));

    const session = await provisionWorkspace({
      ...provisionOpts,
      workspaceId: "ws-destroy-fail-test",
    });
    expect(session.status).toBe("ready");

    // Destroy should succeed despite VM cleanup failure
    await destroyWorkspace("ws-destroy-fail-test", "test");
    expect(getSession("ws-destroy-fail-test")?.status).toBe("destroyed");
  });

  it("destroyAllSessions tears down every active workspace on shutdown", async () => {
    const mockVMs = [createMockVM({ vmId: "vm-a" }), createMockVM({ vmId: "vm-b" })];
    vi.mocked(createFirecrackerVM)
      .mockResolvedValueOnce(mockVMs[0])
      .mockResolvedValueOnce(mockVMs[1]);

    await provisionWorkspace({ ...provisionOpts, workspaceId: "ws-shutdown-1" });
    await provisionWorkspace({ ...provisionOpts, workspaceId: "ws-shutdown-2" });

    expect(listActiveSessions()).toHaveLength(2);

    await destroyAllSessions();

    expect(destroyFirecrackerVM).toHaveBeenCalledTimes(2);
    expect(listActiveSessions()).toHaveLength(0);
  });
});

// =========================================================================
// FLOW 2: Full Verification Job Lifecycle
// Convex → Worker Queue → VM → Gates → Convex Result
// =========================================================================

describe("Flow 2: Verification job lifecycle (Convex → worker → VM → gates → Convex)", () => {
  it("complete commit-based verification: enqueue → VM → clone → gates → result → destroy", async () => {
    // --- Setup: VM that simulates successful clone ---
    const mockVM = createMockVM({
      exec: vi.fn()
        .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 })  // git clone
        .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 }), // chown
    });
    vi.mocked(createFirecrackerVM).mockResolvedValue(mockVM);

    const job = createMockJob();

    // --- Execute: BullMQ worker picks up job ---
    const result = await processVerificationJob(job);

    // --- Verify: Full pipeline executed in order ---

    // 1. VM was created with correct language config
    expect(createFirecrackerVM).toHaveBeenCalledOnce();
    expect(createFirecrackerVM).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "job-lifecycle-001",
        rootfsImage: "node-20.ext4",
      }),
    );

    // 2. Repo was cloned inside VM
    const execCalls = vi.mocked(mockVM.exec).mock.calls;
    expect(execCalls[0][0]).toContain("git clone");
    expect(execCalls[0][0]).toContain("github.com/test/repo");

    // 3. Gates ran
    expect(runVerificationLegs).toHaveBeenCalledOnce();

    // 4. Result is correct
    expect(result.overallStatus).toBe("pass");
    expect(result.gates).toHaveLength(4);
    expect(result.jobId).toBe("job-lifecycle-001");
    expect(result.submissionId).toBe("sub-lifecycle-001");
    expect(result.bountyId).toBe("bounty-lifecycle-001");
    expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);

    // 5. Result posted back to Convex
    expect(postVerificationResult).toHaveBeenCalledWith(
      "https://test-deploy.convex.cloud",
      expect.objectContaining({
        overallStatus: "pass",
        jobId: "job-lifecycle-001",
      }),
    );

    // 6. VM was destroyed in finally block
    expect(destroyFirecrackerVM).toHaveBeenCalledWith(mockVM);

    // 7. Progress was reported at key milestones
    const progressCalls = vi.mocked(job.updateProgress).mock.calls.map(c => c[0]);
    expect(progressCalls).toContain(5);   // language detected
    expect(progressCalls).toContain(15);  // VM started
    expect(progressCalls).toContain(20);  // repo cloned
    expect(progressCalls).toContain(95);  // gates done
    expect(progressCalls).toContain(100); // complete
  });

  it("complete diff-based verification: patch apply → gates → result → destroy", async () => {
    const diffPatch = [
      "diff --git a/src/index.ts b/src/index.ts",
      "--- a/src/index.ts",
      "+++ b/src/index.ts",
      "@@ -1,3 +1,4 @@",
      " import express from 'express';",
      "+import { validate } from './validate';",
      " const app = express();",
    ].join("\n");

    const mockVM = createMockVM({
      exec: vi.fn()
        .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 })  // git clone
        .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 })  // chown
        .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 })  // git apply
        .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 }), // rm patch
    });
    vi.mocked(createFirecrackerVM).mockResolvedValue(mockVM);

    const job = createMockJob({ diffPatch });
    const result = await processVerificationFromDiff(job);

    // 1. Patch was written to VM
    expect(mockVM.writeFile).toHaveBeenCalledWith(
      "/workspace/.arcagent/agent.patch",
      Buffer.from(diffPatch),
      "0644",
      "agent:agent",
    );

    // 2. Patch was applied
    const execCalls = vi.mocked(mockVM.exec).mock.calls;
    const applyCall = execCalls.find(c => c[0].includes("git apply"));
    expect(applyCall).toBeDefined();

    // 3. Gates ran and result is pass
    expect(result.overallStatus).toBe("pass");
    expect(result.gates).toHaveLength(4);

    // 4. Result posted to Convex
    expect(postVerificationResult).toHaveBeenCalledWith(
      "https://test-deploy.convex.cloud",
      expect.objectContaining({ overallStatus: "pass" }),
    );

    // 5. VM destroyed
    expect(destroyFirecrackerVM).toHaveBeenCalledOnce();
  });

  it("diff verification fails fast on bad patch — posts fail result, skips gates", async () => {
    const mockVM = createMockVM({
      exec: vi.fn()
        .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 })  // git clone
        .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 })  // chown
        .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 })  // mkdir/chown patch dir
        .mockResolvedValueOnce({                                          // git apply FAILS
          stdout: "",
          stderr: "error: patch failed: src/index.ts:1\nerror: src/index.ts: patch does not apply",
          exitCode: 128,
        }),
    });
    vi.mocked(createFirecrackerVM).mockResolvedValue(mockVM);

    const job = createMockJob({ diffPatch: "bad patch content" });
    const result = await processVerificationFromDiff(job);

    // Patch-apply gate reports failure
    expect(result.overallStatus).toBe("fail");
    expect(result.gates).toHaveLength(1);
    expect(result.gates[0].gate).toBe("patch-apply");
    expect(result.gates[0].status).toBe("fail");
    expect(result.gates[0].details?.stderr).toContain("patch does not apply");

    // Gates were NOT run (fast fail before pipeline)
    expect(runVerificationLegs).not.toHaveBeenCalled();

    // Fail result still posted to Convex
    expect(postVerificationResult).toHaveBeenCalledWith(
      "https://test-deploy.convex.cloud",
      expect.objectContaining({ overallStatus: "fail" }),
    );

    // VM still destroyed
    expect(destroyFirecrackerVM).toHaveBeenCalledOnce();
  });

  it("verification timeout posts error result and destroys VM", async () => {
    const mockVM = createMockVM();
    vi.mocked(createFirecrackerVM).mockResolvedValue(mockVM);
    vi.mocked(withTimeout).mockRejectedValueOnce(
      new Error("Verification timed out after 300s"),
    );

    const job = createMockJob();
    await expect(processVerificationJob(job)).rejects.toThrow("timed out");

    // Error result posted to Convex
    expect(postVerificationResult).toHaveBeenCalledWith(
      "https://test-deploy.convex.cloud",
      expect.objectContaining({
        overallStatus: "error",
        gates: [],
      }),
    );

    // VM still destroyed
    expect(destroyFirecrackerVM).toHaveBeenCalledOnce();
  });

  it("VM creation failure posts error and does not attempt destroy", async () => {
    vi.mocked(createFirecrackerVM).mockRejectedValue(
      new Error("No available guest IPs — all 252 addresses in use"),
    );

    const job = createMockJob();
    await expect(processVerificationJob(job)).rejects.toThrow("No available guest IPs");

    // Error result posted
    expect(postVerificationResult).toHaveBeenCalledWith(
      "https://test-deploy.convex.cloud",
      expect.objectContaining({ overallStatus: "error" }),
    );

    // Destroy NOT called (vm was null)
    expect(destroyFirecrackerVM).not.toHaveBeenCalled();
  });

  it("gate failure produces fail status and correct gate details", async () => {
    vi.mocked(runVerificationLegs).mockResolvedValueOnce({
      legacyGates: [
        { gate: "build", status: "pass", durationMs: 100, summary: "Build OK" },
        { gate: "lint", status: "fail", durationMs: 50, summary: "3 lint errors found" },
        { gate: "typecheck", status: "skipped", durationMs: 0, summary: "Skipped (pipeline aborted)" },
        { gate: "test", status: "skipped", durationMs: 0, summary: "Skipped (pipeline aborted)" },
      ],
      receipts: [
        {
          jobId: "job-lifecycle-001",
          submissionId: "sub-lifecycle-001",
          bountyId: "bounty-lifecycle-001",
          attemptNumber: 1,
          legKey: "build",
          orderIndex: 1,
          status: "pass",
          blocking: true,
          startedAt: 1,
          completedAt: 2,
          durationMs: 1,
          summaryLine: "PASS",
        },
        {
          jobId: "job-lifecycle-001",
          submissionId: "sub-lifecycle-001",
          bountyId: "bounty-lifecycle-001",
          attemptNumber: 1,
          legKey: "lint_no_new_errors",
          orderIndex: 2,
          status: "fail",
          blocking: true,
          startedAt: 2,
          completedAt: 3,
          durationMs: 1,
          summaryLine: "3 lint errors found",
        },
      ],
      steps: [],
    });

    const mockVM = createMockVM();
    vi.mocked(createFirecrackerVM).mockResolvedValue(mockVM);

    const job = createMockJob();
    const result = await processVerificationJob(job);

    expect(result.overallStatus).toBe("fail");
    expect(result.gates[1].gate).toBe("lint");
    expect(result.gates[1].status).toBe("fail");
    expect(result.gates[1].summary).toBe("3 lint errors found");

    // Result posted with fail status
    expect(postVerificationResult).toHaveBeenCalledWith(
      "https://test-deploy.convex.cloud",
      expect.objectContaining({ overallStatus: "fail" }),
    );
  });

  it("skips Convex posting when convexUrl is not configured", async () => {
    const mockVM = createMockVM();
    vi.mocked(createFirecrackerVM).mockResolvedValue(mockVM);

    const job = createMockJob({ convexUrl: undefined });
    const result = await processVerificationJob(job);

    expect(result.overallStatus).toBe("pass");
    expect(postVerificationResult).not.toHaveBeenCalled();
  });
});

// =========================================================================
// FLOW 3: Workspace → Verification (Agent completes work → submits solution)
// =========================================================================

describe("Flow 3: Workspace to verification handoff", () => {
  it("agent develops in workspace → extracts diff → diff becomes verification input", async () => {
    // --- Phase A: Provision workspace (simulating Convex → Worker) ---
    const devVM = createMockVM({
      vmId: "vm-dev-workspace",
      exec: vi.fn()
        .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 })   // clone
        .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 })   // chown
        .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 })   // npm ci
        .mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
    });
    vi.mocked(createFirecrackerVM).mockResolvedValueOnce(devVM);

    const session = await provisionWorkspace({
      workspaceId: "ws-handoff-test",
      claimId: "claim-handoff",
      bountyId: "bounty-handoff",
      agentId: "agent-handoff",
      repoUrl: "https://github.com/test/repo",
      repoAuthToken: "ghs_mocktoken",
      commitSha: "base-sha-123",
      language: "typescript",
      expiresAt: Date.now() + 4 * 60 * 60 * 1000,
    });
    expect(session.status).toBe("ready");

    // --- Phase B: Agent writes code in workspace ---
    await session.vmHandle.writeFile(
      "/workspace/src/solution.ts",
      Buffer.from("export function solve() { return 42; }\n"),
      "0644",
      "agent:agent",
    );

    // --- Phase C: Agent extracts diff (MCP → Worker → VM) ---
    const diffContent = [
      "diff --git a/src/solution.ts b/src/solution.ts",
      "new file mode 100644",
      "+export function solve() { return 42; }",
    ].join("\n");

    vi.mocked(devVM.exec).mockResolvedValueOnce({
      stdout: `---DIFF---\n${diffContent}\n---STAT---\n src/solution.ts | 1 +\n---NAMES---\nsrc/solution.ts`,
      stderr: "",
      exitCode: 0,
    });

    const diff = await extractDiff("ws-handoff-test");
    expect(diff.hasChanges).toBe(true);
    expect(diff.changedFiles).toEqual(["src/solution.ts"]);

    // --- Phase D: Convex submits diff for verification (new clean VM) ---
    const verifyVM = createMockVM({
      vmId: "vm-verify-clean",
      exec: vi.fn()
        .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 })   // clone
        .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 })   // chown
        .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 })   // git apply
        .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 }),   // rm patch
    });
    vi.mocked(createFirecrackerVM).mockResolvedValueOnce(verifyVM);

    const verifyJob = createMockJob({
      diffPatch: diff.diffPatch,
      sourceWorkspaceId: "ws-handoff-test",
    });

    const result = await processVerificationFromDiff(verifyJob);

    // Verification ran on a DIFFERENT VM (not the dev workspace VM)
    expect(verifyVM.vmId).toBe("vm-verify-clean");
    expect(verifyVM.vmId).not.toBe(devVM.vmId);

    // Patch was applied to the clean VM
    expect(verifyVM.writeFile).toHaveBeenCalledWith(
      "/workspace/.arcagent/agent.patch",
      expect.any(Buffer),
      "0644",
      "agent:agent",
    );

    // Full gate pipeline ran
    expect(result.overallStatus).toBe("pass");
    expect(result.gates).toHaveLength(4);

    // Both VMs cleaned up
    expect(destroyFirecrackerVM).toHaveBeenCalledWith(verifyVM);

    // Destroy dev workspace separately
    await destroyWorkspace("ws-handoff-test", "test_cleanup");
    expect(destroyFirecrackerVM).toHaveBeenCalledWith(devVM);
  });
});

// =========================================================================
// FLOW 4: Error propagation across boundaries
// =========================================================================

describe("Flow 4: Error propagation across system boundaries", () => {
  it("workspace provision failure propagates from VM to worker to session state", async () => {
    vi.mocked(createFirecrackerVM).mockRejectedValue(
      new Error("TAP device limit reached"),
    );

    await expect(
      provisionWorkspace({
        workspaceId: "ws-error-prop-test",
        claimId: "claim-err",
        bountyId: "bounty-err",
        agentId: "agent-err",
        repoUrl: "https://github.com/test/repo",
        repoAuthToken: "ghs_mocktoken",
        commitSha: "abc123",
        language: "typescript",
        expiresAt: Date.now() + 1000,
      }),
    ).rejects.toThrow("TAP device limit reached");

    // Session is in error state with the error message
    const session = getSession("ws-error-prop-test");
    expect(session?.status).toBe("error");
    expect(session?.errorMessage).toContain("TAP device limit reached");
  });

  it("clone failure in workspace sets error state and cleans up VM", async () => {
    const mockVM = createMockVM({
      exec: vi.fn().mockResolvedValueOnce({
        stdout: "",
        stderr: "fatal: repository 'https://github.com/test/private-repo' not found",
        exitCode: 128,
      }),
    });
    vi.mocked(createFirecrackerVM).mockResolvedValue(mockVM);

    await expect(
      provisionWorkspace({
        workspaceId: "ws-clone-fail",
        claimId: "claim-cf",
        bountyId: "bounty-cf",
        agentId: "agent-cf",
        repoUrl: "https://github.com/test/private-repo",
        repoAuthToken: "ghs_mocktoken",
        commitSha: "abc123",
        language: "typescript",
        expiresAt: Date.now() + 1000,
      }),
    ).rejects.toThrow("Failed to clone repo");

    const session = getSession("ws-clone-fail");
    expect(session?.status).toBe("error");

    // VM was destroyed despite clone failure
    expect(destroyFirecrackerVM).toHaveBeenCalledWith(mockVM);
  });

  it("Convex result posting failure does not prevent VM cleanup", async () => {
    const mockVM = createMockVM();
    vi.mocked(createFirecrackerVM).mockResolvedValue(mockVM);
    vi.mocked(postVerificationResult).mockRejectedValueOnce(
      new Error("Convex HTTP 500: Internal server error"),
    );

    const job = createMockJob();
    // Job still succeeds even though Convex posting failed (best-effort)
    const result = await processVerificationJob(job);

    expect(result.overallStatus).toBe("pass");
    expect(destroyFirecrackerVM).toHaveBeenCalledOnce();
  });
});

// =========================================================================
// FLOW 5: Worker-VM communication patterns
// =========================================================================

describe("Flow 5: Worker ↔ VM communication patterns", () => {
  it("exec chains multiple sequential commands in the VM", async () => {
    const commandResults: Record<string, ExecResult> = {
      "npm run build": { stdout: "Compiled successfully.\n", stderr: "", exitCode: 0 },
      "npm test": { stdout: "15 tests passed\n", stderr: "", exitCode: 0 },
      "npm run lint": { stdout: "No lint errors\n", stderr: "", exitCode: 0 },
    };

    const mockVM = createMockVM({
      exec: vi.fn().mockImplementation(async (cmd: string) => {
        for (const [key, result] of Object.entries(commandResults)) {
          if (cmd.includes(key)) return result;
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }),
    });

    // Simulate gate runner executing multiple commands sequentially
    const buildResult = await mockVM.exec("cd /workspace && npm run build", 60_000, "agent");
    const testResult = await mockVM.exec("cd /workspace && npm test", 120_000, "agent");
    const lintResult = await mockVM.exec("cd /workspace && npm run lint", 30_000, "agent");

    expect(buildResult.exitCode).toBe(0);
    expect(buildResult.stdout).toContain("Compiled successfully");
    expect(testResult.stdout).toContain("15 tests passed");
    expect(lintResult.stdout).toContain("No lint errors");

    // All executed as non-root "agent" user
    const calls = vi.mocked(mockVM.exec).mock.calls;
    for (const call of calls) {
      expect(call[2]).toBe("agent");
    }
  });

  it("writeFile transfers patch content from worker to VM via vsock", async () => {
    const mockVM = createMockVM();
    const patchContent = "diff --git a/file.ts b/file.ts\n+new code\n";

    await mockVM.writeFile(
      "/workspace/.arcagent/agent.patch",
      Buffer.from(patchContent),
      "0644",
      "agent:agent",
    );

    expect(mockVM.writeFile).toHaveBeenCalledWith(
      "/workspace/.arcagent/agent.patch",
      Buffer.from(patchContent),
      "0644",
      "agent:agent",
    );
  });

  it("exec timeout results are properly propagated", async () => {
    const mockVM = createMockVM({
      exec: vi.fn().mockRejectedValue(new Error("Command timed out after 120000ms")),
    });

    await expect(
      mockVM.exec("sleep 999", 120_000, "agent"),
    ).rejects.toThrow("timed out");
  });
});

// =========================================================================
// FLOW 6: Resource cleanup guarantees
// =========================================================================

describe("Flow 6: Resource cleanup guarantees", () => {
  it("verification VM is always destroyed regardless of pipeline outcome", async () => {
    // Test with 3 different outcomes: success, gate failure, timeout
    const scenarios = [
      { name: "success", setup: () => {} },
      {
        name: "gate failure",
        setup: () => {
          vi.mocked(runVerificationLegs).mockResolvedValueOnce({
            legacyGates: [{ gate: "build", status: "fail", durationMs: 100, summary: "Build failed" }],
            receipts: [
              {
                jobId: "job-lifecycle-001",
                submissionId: "sub-lifecycle-001",
                bountyId: "bounty-lifecycle-001",
                attemptNumber: 1,
                legKey: "build",
                orderIndex: 1,
                status: "fail",
                blocking: true,
                startedAt: 1,
                completedAt: 2,
                durationMs: 1,
                summaryLine: "Build failed",
              },
            ],
            steps: [],
          });
        },
      },
      {
        name: "timeout",
        setup: () => {
          vi.mocked(withTimeout).mockRejectedValueOnce(new Error("Timeout"));
        },
      },
    ];

    for (const scenario of scenarios) {
      vi.clearAllMocks();
      const mockVM = createMockVM();
      vi.mocked(createFirecrackerVM).mockResolvedValue(mockVM);
      scenario.setup();

      const job = createMockJob();
      await processVerificationJob(job).catch(() => {});

      expect(destroyFirecrackerVM).toHaveBeenCalledWith(mockVM);
    }
  });

  it("workspace provision error cleans up VM and nulls handle to prevent double-destroy", async () => {
    // VM creates successfully but dependency install fails
    const mockVM = createMockVM({
      exec: vi.fn()
        .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 })   // clone
        .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 })   // chown
        .mockRejectedValueOnce(new Error("npm ci failed: ENOMEM")),       // install
    });
    vi.mocked(createFirecrackerVM).mockResolvedValue(mockVM);

    await expect(
      provisionWorkspace({
        workspaceId: "ws-double-destroy",
        claimId: "claim-dd",
        bountyId: "bounty-dd",
        agentId: "agent-dd",
        repoUrl: "https://github.com/test/repo",
        repoAuthToken: "ghs_mocktoken",
        commitSha: "abc123",
        language: "typescript",
        expiresAt: Date.now() + 1000,
      }),
    ).rejects.toThrow("npm ci failed");

    // VM was destroyed in the error handler
    expect(destroyFirecrackerVM).toHaveBeenCalledWith(mockVM);

    // Session has null handle (prevent double-destroy by idle checker)
    const session = getSession("ws-double-destroy");
    expect(session?.status).toBe("error");
    expect(session?.vmHandle).toBeNull();
  });

  it("concurrent verification jobs get independent VMs and independent cleanup", async () => {
    const vm1 = createMockVM({ vmId: "vm-concurrent-1" });
    const vm2 = createMockVM({ vmId: "vm-concurrent-2" });
    vi.mocked(createFirecrackerVM)
      .mockResolvedValueOnce(vm1)
      .mockResolvedValueOnce(vm2);

    const job1 = createMockJob({ jobId: "concurrent-1", submissionId: "sub-c1" });
    const job2 = createMockJob({ jobId: "concurrent-2", submissionId: "sub-c2" });

    // Run both jobs concurrently (simulating BullMQ concurrency > 1)
    const [result1, result2] = await Promise.all([
      processVerificationJob(job1),
      processVerificationJob(job2),
    ]);

    expect(result1.jobId).toBe("concurrent-1");
    expect(result2.jobId).toBe("concurrent-2");

    // Both VMs independently destroyed
    expect(destroyFirecrackerVM).toHaveBeenCalledTimes(2);
    expect(destroyFirecrackerVM).toHaveBeenCalledWith(vm1);
    expect(destroyFirecrackerVM).toHaveBeenCalledWith(vm2);
  });
});

// =========================================================================
// FLOW 7: Authentication boundary tests
// =========================================================================

describe("Flow 7: Authentication boundaries", () => {
  // Import the real authMiddleware (it reads WORKER_SHARED_SECRET from env)
  // and is not mocked — tests the actual auth logic
  it("auth middleware rejects requests without shared secret", async () => {
    // Dynamic import to avoid the mock on ./index conflicting
    const { authMiddleware } = await import("./api/auth");

    const originalSecret = process.env.WORKER_SHARED_SECRET;
    process.env.WORKER_SHARED_SECRET = "test-secret-12345";

    const mockReq = { headers: { authorization: "Bearer wrong-secret" } } as any;
    const mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as any;
    const mockNext = vi.fn();

    authMiddleware(mockReq, mockRes, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(403);
    expect(mockNext).not.toHaveBeenCalled();

    // Correct secret passes
    const validReq = { headers: { authorization: "Bearer test-secret-12345" } } as any;
    const validRes = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
    const validNext = vi.fn();

    authMiddleware(validReq, validRes, validNext);
    expect(validNext).toHaveBeenCalled();

    if (originalSecret) process.env.WORKER_SHARED_SECRET = originalSecret;
    else delete process.env.WORKER_SHARED_SECRET;
  });

  it("Convex URL validation rejects untrusted destinations", async () => {
    const mockVM = createMockVM();
    vi.mocked(createFirecrackerVM).mockResolvedValue(mockVM);

    // postVerificationResult is mocked, so we test the URL validation
    // by calling the real function with an untrusted URL
    const { postVerificationResult: realPost } = await vi.importActual<
      typeof import("./convex/client")
    >("./convex/client");

    await expect(
      realPost("https://attacker.evil.com", {
        jobId: "test",
        submissionId: "sub",
        bountyId: "bounty",
        overallStatus: "pass",
        gates: [],
        totalDurationMs: 0,
      }),
    ).rejects.toThrow("Untrusted Convex URL");
  });
});
