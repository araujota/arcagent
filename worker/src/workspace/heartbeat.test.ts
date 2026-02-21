import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock dependencies before import
vi.mock("../vm/vsockChannel", () => ({
  vsockExec: vi.fn(),
}));
vi.mock("../vm/firecracker", () => ({
  destroyFirecrackerVM: vi.fn(),
}));
vi.mock("./crashReporter", () => ({
  reportCrash: vi.fn(),
}));
vi.mock("./sessionStore", () => ({
  sessionStore: {
    updateHeartbeat: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(null),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    setWorkerHeartbeat: vi.fn().mockResolvedValue(undefined),
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

import { WorkspaceHeartbeat } from "./heartbeat";
import { vsockExec } from "../vm/vsockChannel";
import { destroyFirecrackerVM } from "../vm/firecracker";
import { reportCrash } from "./crashReporter";
import { sessionStore } from "./sessionStore";

const mockVsockExec = vsockExec as ReturnType<typeof vi.fn>;
const mockDestroyVM = destroyFirecrackerVM as ReturnType<typeof vi.fn>;
const mockReportCrash = reportCrash as ReturnType<typeof vi.fn>;
const mockSessionStoreGet = sessionStore.get as ReturnType<typeof vi.fn>;

describe("WorkspaceHeartbeat", () => {
  let heartbeat: WorkspaceHeartbeat;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    heartbeat = new WorkspaceHeartbeat();
  });

  afterEach(() => {
    heartbeat.stopAll();
    vi.useRealTimers();
  });

  it("does not double-monitor the same workspaceId", () => {
    heartbeat.startMonitoring("ws-1", "/sock1", "vm-1");
    heartbeat.startMonitoring("ws-1", "/sock1", "vm-1");
    expect(heartbeat.monitoredCount).toBe(1);
  });

  it("successful vsock ping resets consecutiveFailures", async () => {
    mockVsockExec.mockResolvedValue({ exitCode: 0, stdout: "heartbeat\n", stderr: "" });

    heartbeat.startMonitoring("ws-2", "/sock2", "vm-2");

    // Advance past one heartbeat interval (30s)
    await vi.advanceTimersByTimeAsync(30_000);

    // Verify vsockExec was called
    expect(mockVsockExec).toHaveBeenCalledWith("/sock2", "echo heartbeat", 5_000);
    // Verify heartbeat was updated in Redis
    expect(sessionStore.updateHeartbeat).toHaveBeenCalledWith("ws-2");
  });

  it("failed vsock ping increments consecutiveFailures", async () => {
    mockVsockExec.mockRejectedValue(new Error("connection refused"));

    heartbeat.startMonitoring("ws-3", "/sock3", "vm-3");

    // Advance past one heartbeat
    await vi.advanceTimersByTimeAsync(30_000);

    expect(mockVsockExec).toHaveBeenCalled();
    // No heartbeat update since it failed
    expect(sessionStore.updateHeartbeat).not.toHaveBeenCalled();
  });

  it("after 3 consecutive failures, reports crash and destroys VM", async () => {
    mockVsockExec.mockRejectedValue(new Error("connection refused"));
    mockReportCrash.mockResolvedValue(undefined);
    mockDestroyVM.mockResolvedValue(undefined);
    mockSessionStoreGet.mockResolvedValue({
      workspaceId: "ws-4",
      bountyId: "b-1",
      agentId: "a-1",
      claimId: "c-1",
      vmId: "vm-4",
      workerInstanceId: "worker-1",
      status: "ready",
      guestIp: "10.0.0.2",
      tapDevice: "tap0",
      overlayPath: "/overlay",
      vsockSocketPath: "/sock4",
      firecrackerPid: 1234,
    });

    heartbeat.startMonitoring("ws-4", "/sock4", "vm-4");

    // Advance through 3 heartbeat intervals
    await vi.advanceTimersByTimeAsync(30_000); // failure 1
    await vi.advanceTimersByTimeAsync(30_000); // failure 2
    await vi.advanceTimersByTimeAsync(30_000); // failure 3 -> crash

    expect(mockReportCrash).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-4",
        crashType: "vm_unresponsive",
      }),
    );
    // Workspace should be unmonitored after crash
    expect(heartbeat.monitoredCount).toBe(0);
  });

  it("stopMonitoring clears interval for a specific workspace", () => {
    heartbeat.startMonitoring("ws-5", "/sock5", "vm-5");
    expect(heartbeat.monitoredCount).toBe(1);

    heartbeat.stopMonitoring("ws-5");
    expect(heartbeat.monitoredCount).toBe(0);
  });

  it("stopAll stops all monitors and worker heartbeat", () => {
    heartbeat.startMonitoring("ws-6", "/sock6", "vm-6");
    heartbeat.startMonitoring("ws-7", "/sock7", "vm-7");
    heartbeat.startWorkerHeartbeat("worker-1");

    heartbeat.stopAll();
    expect(heartbeat.monitoredCount).toBe(0);
  });

  it("startWorkerHeartbeat calls setWorkerHeartbeat immediately and on interval", async () => {
    heartbeat.startWorkerHeartbeat("worker-test");

    // Immediate call
    expect(sessionStore.setWorkerHeartbeat).toHaveBeenCalledWith("worker-test");

    vi.clearAllMocks();

    // Advance past worker heartbeat interval (15s)
    await vi.advanceTimersByTimeAsync(15_000);

    expect(sessionStore.setWorkerHeartbeat).toHaveBeenCalledWith("worker-test");
  });

  it("unexpected vsock response counts as failure", async () => {
    // Responds but not with expected "heartbeat" text
    mockVsockExec.mockResolvedValue({ exitCode: 0, stdout: "garbage", stderr: "" });

    heartbeat.startMonitoring("ws-8", "/sock8", "vm-8");

    await vi.advanceTimersByTimeAsync(30_000);

    // Should not update heartbeat in Redis since response was unexpected
    expect(sessionStore.updateHeartbeat).not.toHaveBeenCalled();
  });
});
