import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const createProcessVMMock = vi.fn();
const destroyProcessVMMock = vi.fn();
const isProcessHandleMock = vi.fn();

vi.mock("../index", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("./processBackend", () => ({
  createProcessVM: (...args: unknown[]) => createProcessVMMock(...args),
  destroyProcessVM: (...args: unknown[]) => destroyProcessVMMock(...args),
  isProcessHandle: (...args: unknown[]) => isProcessHandleMock(...args),
}));

describe("firecracker backend selection", () => {
  beforeEach(() => {
    vi.resetModules();
    createProcessVMMock.mockReset();
    destroyProcessVMMock.mockReset();
    isProcessHandleMock.mockReset();
  });

  afterEach(() => {
    delete process.env.WORKER_EXECUTION_BACKEND;
    delete process.env.ALLOW_UNSAFE_PROCESS_BACKEND;
  });

  it("rejects process backend unless unsafe local override is enabled", async () => {
    process.env.WORKER_EXECUTION_BACKEND = "process";

    const mod = await import("./firecracker");
    await expect(mod.createFirecrackerVM({
      jobId: "job-1",
      rootfsImage: "node-20.ext4",
      vcpuCount: 2,
      memSizeMib: 1024,
    })).rejects.toThrow("Process backend is disabled");
  });

  it("delegates to process backend only with explicit unsafe local override", async () => {
    process.env.WORKER_EXECUTION_BACKEND = "process";
    process.env.ALLOW_UNSAFE_PROCESS_BACKEND = "true";

    const expectedHandle = {
      vmId: "proc-123",
      jobId: "job-1",
      guestIp: "127.0.0.1",
      exec: vi.fn(),
    } as any;

    createProcessVMMock.mockResolvedValue(expectedHandle);

    const mod = await import("./firecracker");
    const handle = await mod.createFirecrackerVM({
      jobId: "job-1",
      rootfsImage: "node-20.ext4",
      vcpuCount: 2,
      memSizeMib: 1024,
    });

    expect(createProcessVMMock).toHaveBeenCalledOnce();
    expect(handle).toBe(expectedHandle);
  });

  it("destroyFirecrackerVM delegates to destroyProcessVM for process handles", async () => {
    process.env.WORKER_EXECUTION_BACKEND = "process";

    const processHandle = {
      vmId: "proc-555",
      jobId: "job-2",
      guestIp: "127.0.0.1",
      exec: vi.fn(),
      __backend: "process",
    } as any;

    isProcessHandleMock.mockReturnValue(true);
    destroyProcessVMMock.mockResolvedValue(undefined);

    const mod = await import("./firecracker");
    await mod.destroyFirecrackerVM(processHandle);

    expect(isProcessHandleMock).toHaveBeenCalledWith(processHandle);
    expect(destroyProcessVMMock).toHaveBeenCalledWith(processHandle);
  });
});
