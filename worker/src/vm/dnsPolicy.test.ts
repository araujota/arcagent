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
// Mock child_process
// ---------------------------------------------------------------------------
const mockExecFile = vi.fn();

vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

// ---------------------------------------------------------------------------
// Mock node:fs/promises
// ---------------------------------------------------------------------------
const mockWriteFile = vi.fn().mockResolvedValue(undefined);
const mockUnlink = vi.fn().mockResolvedValue(undefined);
const mockReadFile = vi.fn().mockResolvedValue("12345\n");

vi.mock("node:fs/promises", () => ({
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  unlink: (...args: unknown[]) => mockUnlink(...args),
  readFile: (...args: unknown[]) => mockReadFile(...args),
}));

// ---------------------------------------------------------------------------
// Import module under test
// ---------------------------------------------------------------------------
import {
  startDnsResolver,
  stopDnsResolver,
  applyDnsRedirect,
  removeDnsRedirect,
} from "./dnsPolicy";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupExecFileSuccess() {
  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], optsOrCb?: unknown, cb?: Function) => {
      const callback = typeof optsOrCb === "function" ? optsOrCb : cb;
      if (callback) callback(null, { stdout: "", stderr: "" });
      return Promise.resolve({ stdout: "", stderr: "" });
    },
  );
}

// ---------------------------------------------------------------------------
// Tests: startDnsResolver
// ---------------------------------------------------------------------------

describe("startDnsResolver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupExecFileSuccess();
  });

  it("generates correct dnsmasq config with domain allowlist", async () => {
    const domains = ["github.com", "*.github.com", "registry.npmjs.org"];
    await startDnsResolver("vm-test", "10.0.0.1", domains);

    expect(mockWriteFile).toHaveBeenCalledOnce();
    const [path, content] = mockWriteFile.mock.calls[0];

    expect(path).toBe("/tmp/fc-dns-vm-test.conf");

    // Check key config lines
    expect(content).toContain("listen-address=10.0.0.1");
    expect(content).toContain("bind-interfaces");
    expect(content).toContain("no-resolv");
    expect(content).toContain("server=/github.com/8.8.8.8");
    expect(content).toContain("server=/registry.npmjs.org/8.8.8.8");
  });

  it('config includes address=/#/ catch-all for NXDOMAIN blocking', async () => {
    await startDnsResolver("vm-test", "10.0.0.1", ["example.com"]);

    const content = mockWriteFile.mock.calls[0][1] as string;
    expect(content).toContain("address=/#/");
  });

  it("wildcard domains (*.npmjs.org) produce server=/npmjs.org/8.8.8.8 rules", async () => {
    await startDnsResolver("vm-test", "10.0.0.1", ["*.npmjs.org", "*.pypi.org"]);

    const content = mockWriteFile.mock.calls[0][1] as string;
    expect(content).toContain("server=/npmjs.org/8.8.8.8");
    expect(content).toContain("server=/pypi.org/8.8.8.8");
  });
});

// ---------------------------------------------------------------------------
// Tests: applyDnsRedirect
// ---------------------------------------------------------------------------

describe("applyDnsRedirect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupExecFileSuccess();
  });

  it("adds PREROUTING NAT + FORWARD DROP rules", async () => {
    await applyDnsRedirect("fc-tap-abc", "10.0.0.1");

    const calls = mockExecFile.mock.calls.map((c: unknown[]) => ({
      cmd: c[0] as string,
      args: c[1] as string[],
    }));

    const iptablesCalls = calls.filter((c) => c.cmd === "iptables");
    expect(iptablesCalls.length).toBe(3);

    const allArgs = iptablesCalls.map((c) => c.args.join(" "));

    // PREROUTING NAT DNAT rule
    expect(allArgs.some((a) => a.includes("PREROUTING") && a.includes("nat") && a.includes("DNAT") && a.includes("10.0.0.1:53"))).toBe(true);

    // FORWARD DROP for non-local DNS
    expect(allArgs.some((a) => a.includes("FORWARD") && a.includes("DROP") && a.includes("53"))).toBe(true);

    // Large TXT record blocking
    expect(allArgs.some((a) => a.includes("length") && a.includes("256:65535"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: stopDnsResolver
// ---------------------------------------------------------------------------

describe("stopDnsResolver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupExecFileSuccess();
  });

  it("kills process, removes config/pid/log files", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    await stopDnsResolver({
      vmId: "vm-test",
      configPath: "/tmp/fc-dns-vm-test.conf",
      pidFile: "/tmp/fc-dns-vm-test.pid",
      gatewayIp: "10.0.0.1",
    });

    expect(killSpy).toHaveBeenCalledWith(12345, "SIGTERM");

    const unlinkPaths = mockUnlink.mock.calls.map((c: unknown[]) => c[0]);
    expect(unlinkPaths).toContain("/tmp/fc-dns-vm-test.conf");
    expect(unlinkPaths).toContain("/tmp/fc-dns-vm-test.pid");
    expect(unlinkPaths).toContain("/tmp/fc-dns-vm-test.log");

    killSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Tests: removeDnsRedirect
// ---------------------------------------------------------------------------

describe("removeDnsRedirect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupExecFileSuccess();
  });

  it("removes all 3 iptables rules", async () => {
    await removeDnsRedirect("fc-tap-abc", "10.0.0.1");

    const calls = mockExecFile.mock.calls.filter(
      (c: unknown[]) => c[0] === "iptables",
    );
    expect(calls).toHaveLength(3);

    const allArgs = calls.map((c: unknown[]) => (c[1] as string[]).join(" "));
    // All should be -D (delete)
    expect(allArgs.every((a: string) => a.includes("-D"))).toBe(true);
  });
});
