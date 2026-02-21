import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies before import
vi.mock("uuid", () => ({
  v4: vi.fn(() => "test-uuid-1234"),
}));
vi.mock("../vm/vsockChannel", () => ({
  waitForVsock: vi.fn(),
}));
vi.mock("../vm/firecracker", () => ({
  destroyFirecrackerVM: vi.fn(),
}));
vi.mock("./crashReporter", () => ({
  reportCrash: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./sessionStore", () => ({
  sessionStore: {
    listActive: vi.fn().mockResolvedValue([]),
    getWorkerHeartbeat: vi.fn().mockResolvedValue(null),
    adoptSession: vi.fn().mockResolvedValue(undefined),
    updateHeartbeat: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("../index", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { generateWorkerInstanceId, recoverOrphanedSessions } from "./recovery";
import { waitForVsock } from "../vm/vsockChannel";
import { destroyFirecrackerVM } from "../vm/firecracker";
import { reportCrash } from "./crashReporter";
import { sessionStore } from "./sessionStore";
import type { SessionRecord } from "./sessionStore";

const mockListActive = sessionStore.listActive as ReturnType<typeof vi.fn>;
const mockGetHeartbeat = sessionStore.getWorkerHeartbeat as ReturnType<typeof vi.fn>;
const mockAdoptSession = sessionStore.adoptSession as ReturnType<typeof vi.fn>;
const mockDeleteSession = sessionStore.delete as ReturnType<typeof vi.fn>;
const mockWaitForVsock = waitForVsock as ReturnType<typeof vi.fn>;
const mockDestroyVM = destroyFirecrackerVM as ReturnType<typeof vi.fn>;
const mockReportCrash = reportCrash as ReturnType<typeof vi.fn>;

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    workspaceId: "ws-1",
    vmId: "vm-1",
    vsockSocketPath: "/sock1",
    tapDevice: "tap0",
    overlayPath: "/overlay1",
    guestIp: "10.0.0.2",
    claimId: "claim-1",
    bountyId: "bounty-1",
    agentId: "agent-1",
    language: "typescript",
    baseRepoUrl: "https://github.com/test/repo",
    baseCommitSha: "abc123",
    status: "ready",
    createdAt: Date.now() - 60_000,
    expiresAt: Date.now() + 3_600_000,
    lastActivityAt: Date.now() - 30_000,
    lastHeartbeatAt: Date.now() - 60_000,
    firecrackerPid: 12345,
    workerInstanceId: "old-worker-1",
    ...overrides,
  };
}

describe("generateWorkerInstanceId", () => {
  it("returns worker-{uuid} format", () => {
    const id = generateWorkerInstanceId();
    expect(id).toBe("worker-test-uuid-1234");
  });
});

describe("recoverOrphanedSessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDestroyVM.mockResolvedValue(undefined);
    mockReportCrash.mockResolvedValue(undefined);
  });

  it("returns zero stats when no active sessions", async () => {
    mockListActive.mockResolvedValue([]);

    const stats = await recoverOrphanedSessions("new-worker-1");

    expect(stats).toEqual({ scanned: 0, adopted: 0, destroyed: 0, skipped: 0 });
  });

  it("skips sessions owned by current instanceId", async () => {
    const session = makeSession({ workerInstanceId: "new-worker-1" });
    mockListActive.mockResolvedValue([session]);

    const stats = await recoverOrphanedSessions("new-worker-1");

    expect(stats.skipped).toBe(1);
    expect(stats.adopted).toBe(0);
    expect(stats.destroyed).toBe(0);
  });

  it("skips sessions whose owner worker is still alive", async () => {
    const session = makeSession({ workerInstanceId: "alive-worker" });
    mockListActive.mockResolvedValue([session]);
    mockGetHeartbeat.mockResolvedValue(Date.now()); // alive

    const stats = await recoverOrphanedSessions("new-worker-1");

    expect(stats.skipped).toBe(1);
    expect(stats.adopted).toBe(0);
  });

  it("adopts orphaned 'ready' session with alive PID + responsive vsock", async () => {
    const session = makeSession({
      status: "ready",
      firecrackerPid: process.pid, // use current PID so isPidAlive returns true
    });
    mockListActive.mockResolvedValue([session]);
    mockGetHeartbeat.mockResolvedValue(null); // expired
    mockWaitForVsock.mockResolvedValue(undefined); // vsock success

    const stats = await recoverOrphanedSessions("new-worker-1");

    expect(stats.adopted).toBe(1);
    expect(mockAdoptSession).toHaveBeenCalledWith("ws-1", "new-worker-1");
    expect(sessionStore.updateHeartbeat).toHaveBeenCalledWith("ws-1");
  });

  it("destroys orphaned 'ready' session with alive PID but unresponsive vsock", async () => {
    const session = makeSession({
      status: "ready",
      firecrackerPid: process.pid, // alive PID
    });
    mockListActive.mockResolvedValue([session]);
    mockGetHeartbeat.mockResolvedValue(null); // expired
    mockWaitForVsock.mockRejectedValue(new Error("vsock timeout")); // vsock fails

    const stats = await recoverOrphanedSessions("new-worker-1");

    // recoverSession handles vsock failure internally (doesn't throw),
    // so it counts as adopted from the caller's perspective
    expect(stats.adopted).toBe(1);
    // But the VM was still destroyed and crash reported
    expect(mockDestroyVM).toHaveBeenCalled();
    expect(mockDeleteSession).toHaveBeenCalledWith("ws-1");
    expect(mockReportCrash).toHaveBeenCalledWith(
      expect.objectContaining({
        crashType: "vm_unresponsive",
      }),
    );
  });

  it("cleans up orphaned 'ready' session with dead PID", async () => {
    const session = makeSession({
      status: "ready",
      firecrackerPid: 99999999, // PID that doesn't exist
    });
    mockListActive.mockResolvedValue([session]);
    mockGetHeartbeat.mockResolvedValue(null); // expired

    const stats = await recoverOrphanedSessions("new-worker-1");

    // Dead PID -> session delete + crash report, but no VM destroy needed
    // Since isPidAlive(99999999) = false, it goes to the delete+crash path
    // That path doesn't throw, so it counts as adopted from recoverOrphanedSessions' perspective
    // Actually recoverSession doesn't throw for dead PID path, so it's adopted
    expect(mockDeleteSession).toHaveBeenCalledWith("ws-1");
    expect(mockReportCrash).toHaveBeenCalledWith(
      expect.objectContaining({
        crashType: "vm_process_exited",
      }),
    );
  });

  it("deletes non-ready orphaned session and reports crash", async () => {
    const session = makeSession({
      status: "error",
      workerInstanceId: "dead-worker",
    });
    mockListActive.mockResolvedValue([session]);
    mockGetHeartbeat.mockResolvedValue(null); // expired

    const stats = await recoverOrphanedSessions("new-worker-1");

    expect(mockDeleteSession).toHaveBeenCalledWith("ws-1");
    expect(mockReportCrash).toHaveBeenCalledWith(
      expect.objectContaining({
        crashType: "worker_restart",
        errorMessage: expect.stringContaining("error"),
      }),
    );
  });
});
