import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock logger
// ---------------------------------------------------------------------------
vi.mock("../index", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Mock child_process (execFile)
// vi.hoisted ensures the fn is available before vi.mock hoisting
// ---------------------------------------------------------------------------
const { mockExecFile } = vi.hoisted(() => {
  const mockExecFile = vi.fn();
  return { mockExecFile };
});

vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
}));

// ---------------------------------------------------------------------------
// Mock uuid
// ---------------------------------------------------------------------------
vi.mock("uuid", () => ({
  v4: vi.fn().mockReturnValue("abcd1234-0000-0000-0000-000000000000"),
}));

// ---------------------------------------------------------------------------
// Mock vsockChannel
// ---------------------------------------------------------------------------
const { mockVsockExec, mockVsockExecWithStdin, mockVsockWriteFile, mockWaitForVsock } = vi.hoisted(() => ({
  mockVsockExec: vi.fn(),
  mockVsockExecWithStdin: vi.fn(),
  mockVsockWriteFile: vi.fn(),
  mockWaitForVsock: vi.fn(),
}));

vi.mock("./vsockChannel", () => ({
  vsockExec: mockVsockExec,
  vsockExecWithStdin: mockVsockExecWithStdin,
  vsockWriteFile: mockVsockWriteFile,
  waitForVsock: mockWaitForVsock,
  sendVsockRequestPooled: vi.fn(),
  vsockPool: {
    destroy: vi.fn(),
    destroyAll: vi.fn(),
    acquire: vi.fn(),
    release: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Mock encryptedOverlay
// ---------------------------------------------------------------------------
const { mockCreateEncryptedOverlay, mockDestroyEncryptedOverlay } = vi.hoisted(() => ({
  mockCreateEncryptedOverlay: vi.fn(),
  mockDestroyEncryptedOverlay: vi.fn(),
}));

vi.mock("./encryptedOverlay", () => ({
  createEncryptedOverlay: mockCreateEncryptedOverlay,
  destroyEncryptedOverlay: mockDestroyEncryptedOverlay,
}));

// ---------------------------------------------------------------------------
// Mock dnsPolicy
// ---------------------------------------------------------------------------
vi.mock("./dnsPolicy", () => ({
  startDnsResolver: vi.fn().mockResolvedValue({
    vmId: "vm-abcd1234",
    configPath: "/tmp/fc-dns-vm-abcd1234.conf",
    pidFile: "/tmp/fc-dns-vm-abcd1234.pid",
    gatewayIp: "10.0.0.1",
  }),
  stopDnsResolver: vi.fn().mockResolvedValue(undefined),
  applyDnsRedirect: vi.fn().mockResolvedValue(undefined),
  removeDnsRedirect: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Mock egressProxy
// ---------------------------------------------------------------------------
vi.mock("./egressProxy", () => ({
  startEgressProxy: vi.fn().mockResolvedValue({
    vmId: "vm-abcd1234",
    configPath: "/tmp/fc-proxy-vm-abcd1234.conf",
    pidFile: "/tmp/fc-proxy-vm-abcd1234.pid",
    port: 13500,
  }),
  stopEgressProxy: vi.fn().mockResolvedValue(undefined),
  applyProxyRedirect: vi.fn().mockResolvedValue(undefined),
  removeProxyRedirect: vi.fn().mockResolvedValue(undefined),
  applyRateLimiting: vi.fn().mockResolvedValue(undefined),
  removeRateLimiting: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Mock vmConfig
// ---------------------------------------------------------------------------
vi.mock("./vmConfig", () => ({
  getVMConfig: vi.fn().mockReturnValue({
    rootfsImage: "node-20.ext4",
    vcpuCount: 2,
    memSizeMib: 1024,
    defaultGateTimeoutMs: 120_000,
    vsockPort: 5000,
    allowedDomains: ["github.com", "*.github.com", "registry.npmjs.org"],
  }),
}));

// ---------------------------------------------------------------------------
// Mock node:fs/promises (used inside firecracker.ts via dynamic import)
// ---------------------------------------------------------------------------
const { mockFsWriteFile, mockFsChmod, mockFsUnlink } = vi.hoisted(() => ({
  mockFsWriteFile: vi.fn(),
  mockFsChmod: vi.fn(),
  mockFsUnlink: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  writeFile: mockFsWriteFile,
  chmod: mockFsChmod,
  unlink: mockFsUnlink,
}));

// ---------------------------------------------------------------------------
// Import module under test
// ---------------------------------------------------------------------------
import { createFirecrackerVM, destroyFirecrackerVM, type VMHandle } from "./firecracker";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a minimal ChildProcess-like object for raw execFile calls. */
function createMockChildProcess() {
  const child: Record<string, unknown> = {
    pid: 12345,
    stdout: {
      on(_event: string, _handler: Function) { return this; },
    },
    stderr: {
      on(_event: string, _handler: Function) { return this; },
    },
    on(event: string, handler: Function) {
      // Simulate successful exit on next microtask
      if (event === "close") queueMicrotask(() => handler(0));
      return child;
    },
  };
  return child;
}

function defaultExecFileMock() {
  mockExecFile.mockImplementation(
    (cmd: string, args: string[], optsOrCb?: unknown, cb?: Function) => {
      const callback = typeof optsOrCb === "function" ? optsOrCb : cb;
      if (cmd === "debugfs") {
        if (callback) callback(null, { stdout: "Inode: 42\nSize: 2457600\n", stderr: "" });
        return createMockChildProcess();
      }
      if (callback) callback(null, { stdout: "", stderr: "" });
      // Return ChildProcess-like object for raw execFile calls (e.g. jailer launch).
      // For promisified calls the return value is ignored by promisify.
      return createMockChildProcess();
    },
  );
}

function execFileCalls(): Array<{ cmd: string; args: string[] }> {
  return mockExecFile.mock.calls.map((c: unknown[]) => ({
    cmd: c[0] as string,
    args: c[1] as string[],
  }));
}

function findExecCalls(cmd: string): Array<{ cmd: string; args: string[] }> {
  return execFileCalls().filter((c) => c.cmd === cmd);
}

// ---------------------------------------------------------------------------
// Tests: createFirecrackerVM
// ---------------------------------------------------------------------------

describe("createFirecrackerVM", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    defaultExecFileMock();
    mockFsWriteFile.mockResolvedValue(undefined);
    mockFsChmod.mockResolvedValue(undefined);
    mockFsUnlink.mockResolvedValue(undefined);
    mockVsockExec.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
    mockVsockExecWithStdin.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
    mockVsockWriteFile.mockResolvedValue(undefined);
    mockWaitForVsock.mockResolvedValue(undefined);
    mockCreateEncryptedOverlay.mockResolvedValue({
      loopDevice: "/dev/loop0",
      cryptName: "fc-crypt-vm-abcd1234",
      devicePath: "/dev/mapper/fc-crypt-vm-abcd1234",
      backingFile: "/tmp/fc-overlay-vm-abcd1234.ext4",
      keyBuffer: Buffer.alloc(32),
    });
    mockDestroyEncryptedOverlay.mockResolvedValue(undefined);
  });

  it("creates TAP device with correct name derived from vmId", async () => {
    await createFirecrackerVM({
      jobId: "job-1",
      rootfsImage: "node-20.ext4",
      vcpuCount: 2,
      memSizeMib: 1024,
    });

    // vmId = "vm-abcd1234" → tapDevice = "fc-tap-abcd1234"
    const tapCalls = findExecCalls("ip").filter(
      (c) => c.args.includes("tuntap") && c.args.includes("add"),
    );
    expect(tapCalls.length).toBeGreaterThanOrEqual(1);
    expect(tapCalls[0].args).toContain("fc-tap-abcd1234");
  });

  it("assigns IP via allocateGuestIp (verify 10.0.0.x range)", async () => {
    const handle = await createFirecrackerVM({
      jobId: "job-1",
      rootfsImage: "node-20.ext4",
      vcpuCount: 2,
      memSizeMib: 1024,
    });

    expect(handle.guestIp).toMatch(/^10\.0\.0\.\d+$/);
    const octet = parseInt(handle.guestIp.split(".")[3], 10);
    expect(octet).toBeGreaterThanOrEqual(2);
    expect(octet).toBeLessThanOrEqual(253);
  });

  it("applies iptables egress filtering (4 rules: conntrack, UDP 53, TCP 443, DROP)", async () => {
    await createFirecrackerVM({
      jobId: "job-1",
      rootfsImage: "node-20.ext4",
      vcpuCount: 2,
      memSizeMib: 1024,
    });

    const iptablesCalls = findExecCalls("iptables");
    expect(iptablesCalls.length).toBeGreaterThanOrEqual(4);

    const ruleArgs = iptablesCalls.map((c) => c.args.join(" "));
    expect(ruleArgs.some((r) => r.includes("conntrack") && r.includes("ESTABLISHED,RELATED"))).toBe(true);
    expect(ruleArgs.some((r) => r.includes("udp") && r.includes("53"))).toBe(true);
    expect(ruleArgs.some((r) => r.includes("tcp") && r.includes("443"))).toBe(true);
    expect(ruleArgs.some((r) => r.includes("DROP"))).toBe(true);
  });

  it("uses encrypted overlay when available", async () => {
    await createFirecrackerVM({
      jobId: "job-1",
      rootfsImage: "node-20.ext4",
      vcpuCount: 2,
      memSizeMib: 1024,
    });

    expect(mockCreateEncryptedOverlay).toHaveBeenCalled();
  });

  it("falls back to plain copy when encrypted overlay fails", async () => {
    mockCreateEncryptedOverlay.mockRejectedValueOnce(new Error("dm-crypt unavailable"));

    await createFirecrackerVM({
      jobId: "job-1",
      rootfsImage: "node-20.ext4",
      vcpuCount: 2,
      memSizeMib: 1024,
    });

    const cpCalls = findExecCalls("cp");
    expect(cpCalls.length).toBeGreaterThanOrEqual(1);
    expect(cpCalls[0].args).toContain("--reflink=auto");
  });

  it("builds config JSON and writes it", async () => {
    await createFirecrackerVM({
      jobId: "job-1",
      rootfsImage: "node-20.ext4",
      vcpuCount: 2,
      memSizeMib: 1024,
    });

    expect(mockFsWriteFile).toHaveBeenCalled();
    const call = mockFsWriteFile.mock.calls[0];
    expect(call[0]).toMatch(/fc-config-vm-abcd1234\.json$/);

    const configJson = JSON.parse(call[1] as string);
    expect(configJson["boot-source"]).toBeDefined();
    expect(configJson["drives"]).toBeDefined();
    expect(configJson["machine-config"]).toBeDefined();
    expect(configJson["network-interfaces"]).toBeDefined();
  });

  it("includes vsock device config when USE_VSOCK=true (default)", async () => {
    await createFirecrackerVM({
      jobId: "job-1",
      rootfsImage: "node-20.ext4",
      vcpuCount: 2,
      memSizeMib: 1024,
    });

    const call = mockFsWriteFile.mock.calls[0];
    const configJson = JSON.parse(call[1] as string);
    expect(configJson["vsock"]).toBeDefined();
    expect(configJson["vsock"].guest_cid).toBe(3);
    expect(configJson["vsock"].uds_path).toMatch(/fc-vsock-vm-abcd1234\.sock$/);
  });

  it("launches jailer with correct arguments", async () => {
    await createFirecrackerVM({
      jobId: "job-1",
      rootfsImage: "node-20.ext4",
      vcpuCount: 2,
      memSizeMib: 1024,
    });

    const allCalls = execFileCalls();
    const jailerCall = allCalls.find(
      (c) => c.cmd === "/usr/local/bin/jailer" || c.args?.includes("--id"),
    );
    expect(jailerCall).toBeDefined();
    expect(jailerCall!.args).toContain("--id");
    expect(jailerCall!.args).toContain("vm-abcd1234");
    expect(jailerCall!.args).toContain("--uid");
    expect(jailerCall!.args).toContain("1001");
    expect(jailerCall!.args).toContain("--gid");
    expect(jailerCall!.args).toContain("1001");
  });

  it("calls waitForVsock after launch", async () => {
    await createFirecrackerVM({
      jobId: "job-1",
      rootfsImage: "node-20.ext4",
      vcpuCount: 2,
      memSizeMib: 1024,
    });

    expect(mockWaitForVsock).toHaveBeenCalledWith(
      expect.stringMatching(/fc-vsock-vm-abcd1234\.sock$/),
      "vm-abcd1234",
    );
  });

  it("returns VMHandle with exec/writeFile closures that delegate to vsock", async () => {
    const handle = await createFirecrackerVM({
      jobId: "job-1",
      rootfsImage: "node-20.ext4",
      vcpuCount: 2,
      memSizeMib: 1024,
    });

    expect(handle.vmId).toBe("vm-abcd1234");
    expect(handle.jobId).toBe("job-1");
    expect(handle.exec).toBeTypeOf("function");
    expect(handle.writeFile).toBeTypeOf("function");

    // Call exec and verify it delegates to vsockExec
    mockVsockExec.mockResolvedValueOnce({ stdout: "hello", stderr: "", exitCode: 0 });
    const result = await handle.exec("echo hello");
    expect(mockVsockExec).toHaveBeenCalled();
    expect(result.stdout).toBe("hello");

    // Call writeFile and verify it delegates to vsockWriteFile
    await handle.writeFile!("/tmp/f", Buffer.from("data"), "0644", "root:root");
    expect(mockVsockWriteFile).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: destroyFirecrackerVM
// ---------------------------------------------------------------------------

describe("destroyFirecrackerVM", () => {
  let handle: VMHandle;

  beforeEach(async () => {
    vi.clearAllMocks();
    defaultExecFileMock();
    mockFsWriteFile.mockResolvedValue(undefined);
    mockFsChmod.mockResolvedValue(undefined);
    mockFsUnlink.mockResolvedValue(undefined);
    mockVsockExec.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
    mockVsockExecWithStdin.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
    mockVsockWriteFile.mockResolvedValue(undefined);
    mockWaitForVsock.mockResolvedValue(undefined);
    mockCreateEncryptedOverlay.mockResolvedValue({
      loopDevice: "/dev/loop0",
      cryptName: "fc-crypt-vm-abcd1234",
      devicePath: "/dev/mapper/fc-crypt-vm-abcd1234",
      backingFile: "/tmp/fc-overlay-vm-abcd1234.ext4",
      keyBuffer: Buffer.alloc(32),
    });
    mockDestroyEncryptedOverlay.mockResolvedValue(undefined);

    handle = await createFirecrackerVM({
      jobId: "job-1",
      rootfsImage: "node-20.ext4",
      vcpuCount: 2,
      memSizeMib: 1024,
    });

    vi.clearAllMocks();
    mockFsUnlink.mockResolvedValue(undefined);
    mockDestroyEncryptedOverlay.mockResolvedValue(undefined);

    // Make ip link show throw (expected — TAP device gone)
    mockExecFile.mockImplementation(
      (cmd: string, args: string[], optsOrCb?: unknown, cb?: Function) => {
        const callback = typeof optsOrCb === "function" ? optsOrCb : cb;
        if (cmd === "ip" && args?.includes("show")) {
          if (callback) callback(new Error("Device not found"), { stdout: "", stderr: "" });
          return Promise.reject(new Error("Device not found"));
        }
        if (callback) callback(null, { stdout: "", stderr: "" });
        return Promise.resolve({ stdout: "", stderr: "" });
      },
    );
  });

  it("kills process, removes egress, removes TAP, removes overlay in correct order", async () => {
    // Mock process.kill to simulate ESRCH (process already exited) to avoid 2s timeout
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => { throw new Error("ESRCH"); });

    await destroyFirecrackerVM(handle);

    // Should attempt PID-based kill (not pkill fallback) since fcChild.pid was captured
    expect(killSpy).toHaveBeenCalledWith(12345, "SIGTERM");

    const ipCalls = findExecCalls("ip");
    const tapDel = ipCalls.find(
      (c) => c.args.includes("tuntap") && c.args.includes("del"),
    );
    expect(tapDel).toBeDefined();

    killSpy.mockRestore();
  });

  it("removes encrypted overlay when present", async () => {
    await destroyFirecrackerVM(handle);
    expect(mockDestroyEncryptedOverlay).toHaveBeenCalled();
  });

  it("removes config JSON, vsock socket", async () => {
    await destroyFirecrackerVM(handle);

    const unlinkCalls = mockFsUnlink.mock.calls.map((c: unknown[]) => c[0]);

    expect(unlinkCalls.some((p: string) => p.includes("fc-config-"))).toBe(true);
    expect(unlinkCalls.some((p: string) => p.includes("fc-vsock-"))).toBe(true);
  });

  it("verifies TAP device removal (runs ip link show)", async () => {
    await destroyFirecrackerVM(handle);

    const ipCalls = findExecCalls("ip");
    const showCall = ipCalls.find(
      (c) => c.args.includes("link") && c.args.includes("show"),
    );
    expect(showCall).toBeDefined();
  });
});
