import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { VMHandle, ExecResult } from "../vm/firecracker";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../vm/firecracker", () => ({
  createFirecrackerVM: vi.fn(),
  destroyFirecrackerVM: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../vm/vmConfig", () => ({
  getVMConfig: vi.fn().mockReturnValue({
    rootfsImage: "node-20.ext4",
    vcpuCount: 2,
    memSizeMib: 2048,
    defaultGateTimeoutMs: 120_000,
    vsockPort: 5000,
    allowedDomains: [
      "github.com",
      "*.github.com",
      "objects.githubusercontent.com",
      "registry.npmjs.org",
    ],
  }),
}));

vi.mock("../lib/shellSanitize", () => ({
  sanitizeShellArg: vi.fn((value: string) => `'${value}'`),
}));

vi.mock("../index", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../vm/vmPool", () => ({
  vmPool: {
    acquire: vi.fn().mockResolvedValue(null),
    drainAll: vi.fn().mockResolvedValue(undefined),
    initialize: vi.fn().mockResolvedValue(undefined),
  },
}));

// Import after mocks are declared
import { createFirecrackerVM, destroyFirecrackerVM } from "../vm/firecracker";
import {
  provisionWorkspace,
  getSession,
  destroyWorkspace,
  extractDiff,
  extendTTL,
  touchActivity,
  listActiveSessions,
  destroyAllSessions,
  type ProvisionOptions,
} from "./sessionManager";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockVMHandle(overrides?: Partial<VMHandle>): VMHandle {
  return {
    vmId: "vm-test1234",
    jobId: "ws-test",
    guestIp: "10.0.0.42",
    exec: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 } as ExecResult),
    writeFile: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as VMHandle;
}

function makeProvisionOpts(overrides?: Partial<ProvisionOptions>): ProvisionOptions {
  return {
    workspaceId: `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    claimId: "claim-abc",
    bountyId: "bounty-xyz",
    agentId: "agent-007",
    repoUrl: "https://github.com/test-org/test-repo",
    commitSha: "abc1234def5678",
    language: "typescript",
    expiresAt: Date.now() + 3_600_000, // 1 hour from now
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.clearAllMocks();
});

afterEach(async () => {
  // Clean up all sessions to prevent cross-test pollution of the module-level Map
  await destroyAllSessions();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// provisionWorkspace
// ---------------------------------------------------------------------------

describe("provisionWorkspace", () => {
  it("provisions workspace and returns ready session", async () => {
    const mockVM = createMockVMHandle();
    vi.mocked(createFirecrackerVM).mockResolvedValue(mockVM);

    const opts = makeProvisionOpts();
    const session = await provisionWorkspace(opts);

    // Session should be ready
    expect(session.status).toBe("ready");
    expect(session.vmHandle).toBe(mockVM);
    expect(session.workspaceId).toBe(opts.workspaceId);
    expect(session.claimId).toBe(opts.claimId);
    expect(session.bountyId).toBe(opts.bountyId);
    expect(session.agentId).toBe(opts.agentId);
    expect(session.language).toBe("typescript");
    expect(session.readyAt).toBeDefined();
    expect(session.readyAt).toBeGreaterThan(0);

    // createFirecrackerVM should have been called
    expect(createFirecrackerVM).toHaveBeenCalledOnce();
    expect(createFirecrackerVM).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: opts.workspaceId,
      }),
    );

    // Repo clone command should have been executed
    const execCalls = vi.mocked(mockVM.exec).mock.calls;
    const cloneCall = execCalls.find(([cmd]) =>
      typeof cmd === "string" && cmd.includes("git clone"),
    );
    expect(cloneCall).toBeDefined();

    // chown should have been called to set ownership
    const chownCall = execCalls.find(([cmd]) =>
      typeof cmd === "string" && cmd.includes("chown"),
    );
    expect(chownCall).toBeDefined();

    // Session should be retrievable via getSession
    expect(getSession(opts.workspaceId)).toBe(session);

    // Session should appear in listActiveSessions
    const active = listActiveSessions();
    expect(active.some((s) => s.workspaceId === opts.workspaceId)).toBe(true);
  });

  it("rejects when capacity limit reached", async () => {
    const mockVM = createMockVMHandle();
    vi.mocked(createFirecrackerVM).mockResolvedValue(mockVM);

    // MAX_DEV_VMS defaults to 10 via process.env.MAX_DEV_VMS ?? "10"
    // Fill up to capacity
    const sessions: Array<{ workspaceId: string }> = [];
    for (let i = 0; i < 10; i++) {
      const opts = makeProvisionOpts({
        workspaceId: `ws-capacity-${i}`,
      });
      await provisionWorkspace(opts);
      sessions.push(opts);
    }

    // The 11th provision should fail with a capacity error
    const overflowOpts = makeProvisionOpts({
      workspaceId: "ws-capacity-overflow",
    });
    await expect(provisionWorkspace(overflowOpts)).rejects.toThrow(
      "Worker at capacity",
    );
  });

  it("installs dependencies based on language", async () => {
    const mockVM = createMockVMHandle();
    vi.mocked(createFirecrackerVM).mockResolvedValue(mockVM);

    const opts = makeProvisionOpts({ language: "python" });
    await provisionWorkspace(opts);

    // installDependencies should have called exec with pip install
    const execCalls = vi.mocked(mockVM.exec).mock.calls;
    const pipCall = execCalls.find(([cmd]) =>
      typeof cmd === "string" && cmd.includes("pip install"),
    );
    expect(pipCall).toBeDefined();
    // Python deps are run as "agent" user
    expect(pipCall![2]).toBe("agent");
  });
});

// ---------------------------------------------------------------------------
// extractDiff
// ---------------------------------------------------------------------------

describe("extractDiff", () => {
  it("returns diff output for ready workspace", async () => {
    const mockVM = createMockVMHandle();

    // extractDiff now uses a single combined command with delimiter markers
    vi.mocked(mockVM.exec).mockImplementation(
      async (command: string): Promise<ExecResult> => {
        if (command.includes("git add -A") && command.includes("---DIFF---")) {
          // Combined command: git add + diff + stat + names
          return {
            stdout:
              "---DIFF---\n" +
              "diff --git a/src/index.ts b/src/index.ts\n--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-old\n+new\n" +
              "---STAT---\n" +
              " src/index.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n" +
              "---NAMES---\n" +
              "src/index.ts\n",
            stderr: "",
            exitCode: 0,
          };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    );

    vi.mocked(createFirecrackerVM).mockResolvedValue(mockVM);

    const opts = makeProvisionOpts();
    await provisionWorkspace(opts);

    const diff = await extractDiff(opts.workspaceId);

    expect(diff).toEqual({
      diffPatch: expect.stringContaining("diff --git"),
      diffStat: expect.stringContaining("1 file changed"),
      changedFiles: ["src/index.ts"],
      hasChanges: true,
    });
    // Only 1 exec call for diff (not 4 separate ones) — plus the provisioning calls
    const diffCalls = vi.mocked(mockVM.exec).mock.calls.filter(
      ([cmd]) => typeof cmd === "string" && cmd.includes("---DIFF---"),
    );
    expect(diffCalls).toHaveLength(1);
  });

  it("throws for non-ready workspace", async () => {
    // Calling extractDiff on a workspaceId that does not exist should throw
    await expect(extractDiff("ws-nonexistent")).rejects.toThrow(
      "Workspace not ready",
    );
  });
});

// ---------------------------------------------------------------------------
// destroyWorkspace
// ---------------------------------------------------------------------------

describe("destroyWorkspace", () => {
  it("destroys VM and marks session destroyed", async () => {
    const mockVM = createMockVMHandle();
    vi.mocked(createFirecrackerVM).mockResolvedValue(mockVM);

    const opts = makeProvisionOpts();
    const session = await provisionWorkspace(opts);

    expect(session.status).toBe("ready");

    await destroyWorkspace(opts.workspaceId, "test_cleanup");

    // destroyFirecrackerVM should have been called with the VM handle
    expect(destroyFirecrackerVM).toHaveBeenCalledWith(mockVM);

    // Session status should be "destroyed"
    const destroyed = getSession(opts.workspaceId);
    expect(destroyed).toBeDefined();
    expect(destroyed!.status).toBe("destroyed");
  });

  it("is idempotent for already-destroyed workspace", async () => {
    const mockVM = createMockVMHandle();
    vi.mocked(createFirecrackerVM).mockResolvedValue(mockVM);

    const opts = makeProvisionOpts();
    await provisionWorkspace(opts);

    // Destroy once
    await destroyWorkspace(opts.workspaceId, "first");

    // Reset the mock call count
    vi.mocked(destroyFirecrackerVM).mockClear();

    // Destroy again - should not throw and should not call destroyFirecrackerVM again
    await expect(
      destroyWorkspace(opts.workspaceId, "second"),
    ).resolves.toBeUndefined();

    // destroyFirecrackerVM should NOT have been called again
    expect(destroyFirecrackerVM).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// extendTTL
// ---------------------------------------------------------------------------

describe("extendTTL", () => {
  it("updates expiresAt", async () => {
    const mockVM = createMockVMHandle();
    vi.mocked(createFirecrackerVM).mockResolvedValue(mockVM);

    const originalExpiry = Date.now() + 3_600_000;
    const opts = makeProvisionOpts({ expiresAt: originalExpiry });
    const session = await provisionWorkspace(opts);

    expect(session.expiresAt).toBe(originalExpiry);

    const newExpiry = Date.now() + 7_200_000; // 2 hours from now
    extendTTL(opts.workspaceId, newExpiry);

    const updated = getSession(opts.workspaceId);
    expect(updated).toBeDefined();
    expect(updated!.expiresAt).toBe(newExpiry);
  });
});

// ---------------------------------------------------------------------------
// touchActivity
// ---------------------------------------------------------------------------

describe("touchActivity", () => {
  it("updates lastActivityAt", async () => {
    const mockVM = createMockVMHandle();
    vi.mocked(createFirecrackerVM).mockResolvedValue(mockVM);

    const opts = makeProvisionOpts();
    const session = await provisionWorkspace(opts);

    const originalActivity = session.lastActivityAt;

    // Advance time so the next Date.now() returns a different value
    vi.advanceTimersByTime(5000);

    touchActivity(opts.workspaceId);

    const updated = getSession(opts.workspaceId);
    expect(updated).toBeDefined();
    expect(updated!.lastActivityAt).toBeGreaterThan(originalActivity);
  });
});
