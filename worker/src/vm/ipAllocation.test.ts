import { describe, it, expect, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Direct unit test of IP allocation logic.
// We test the exported helpers without mocking — these are pure functions.
// ---------------------------------------------------------------------------

// Import the actual module but access internal state via exports
import { _getAllocatedIps, releaseGuestIp } from "./firecracker";

// We need to mock everything else that firecracker.ts imports
import { vi } from "vitest";

vi.mock("../index", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("./vsockChannel", () => ({
  vsockExec: vi.fn(),
  vsockExecWithStdin: vi.fn(),
  vsockWriteFile: vi.fn(),
  waitForVsock: vi.fn(),
  sendVsockRequestPooled: vi.fn(),
}));
vi.mock("./encryptedOverlay", () => ({
  createEncryptedOverlay: vi.fn(),
  destroyEncryptedOverlay: vi.fn(),
}));
vi.mock("./dnsPolicy", () => ({
  startDnsResolver: vi.fn(),
  stopDnsResolver: vi.fn(),
  applyDnsRedirect: vi.fn(),
  removeDnsRedirect: vi.fn(),
}));
vi.mock("./egressProxy", () => ({
  startEgressProxy: vi.fn(),
  stopEgressProxy: vi.fn(),
  applyProxyRedirect: vi.fn(),
  removeProxyRedirect: vi.fn(),
  applyRateLimiting: vi.fn(),
  removeRateLimiting: vi.fn(),
}));
vi.mock("./vmConfig", () => ({
  getVMConfig: vi.fn().mockReturnValue({
    rootfsImage: "node-20.ext4",
    vcpuCount: 2,
    memSizeMib: 1024,
    defaultGateTimeoutMs: 120_000,
    vsockPort: 5000,
    allowedDomains: [],
  }),
}));

describe("IP allocation registry", () => {
  beforeEach(() => {
    // Clear the allocated IPs set before each test
    const ips = _getAllocatedIps();
    ips.clear();
  });

  it("releaseGuestIp removes IP from registry", () => {
    const ips = _getAllocatedIps();
    ips.add("10.0.0.42");
    expect(ips.has("10.0.0.42")).toBe(true);

    releaseGuestIp("10.0.0.42");
    expect(ips.has("10.0.0.42")).toBe(false);
  });

  it("releaseGuestIp is safe for unknown IPs", () => {
    expect(() => releaseGuestIp("10.0.0.99")).not.toThrow();
  });

  it("allocated IPs set starts empty", () => {
    const ips = _getAllocatedIps();
    expect(ips.size).toBe(0);
  });

  it("registry tracks multiple IPs", () => {
    const ips = _getAllocatedIps();
    ips.add("10.0.0.10");
    ips.add("10.0.0.20");
    ips.add("10.0.0.30");
    expect(ips.size).toBe(3);

    releaseGuestIp("10.0.0.20");
    expect(ips.size).toBe(2);
    expect(ips.has("10.0.0.20")).toBe(false);
    expect(ips.has("10.0.0.10")).toBe(true);
    expect(ips.has("10.0.0.30")).toBe(true);
  });
});
