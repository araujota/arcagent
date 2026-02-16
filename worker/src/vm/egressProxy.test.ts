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
const mockReadFile = vi.fn().mockResolvedValue("54321\n");

vi.mock("node:fs/promises", () => ({
  writeFile: (...args: unknown[]) => mockWriteFile(...args),
  unlink: (...args: unknown[]) => mockUnlink(...args),
  readFile: (...args: unknown[]) => mockReadFile(...args),
}));

// ---------------------------------------------------------------------------
// Import module under test
// ---------------------------------------------------------------------------
import {
  startEgressProxy,
  stopEgressProxy,
  applyProxyRedirect,
  removeProxyRedirect,
  applyRateLimiting,
  removeRateLimiting,
} from "./egressProxy";

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
// Tests: startEgressProxy
// ---------------------------------------------------------------------------

describe("startEgressProxy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupExecFileSuccess();
  });

  it("generates Squid config with SNI ACLs for each domain", async () => {
    const domains = ["github.com", "registry.npmjs.org"];
    await startEgressProxy("vm-test", domains);

    expect(mockWriteFile).toHaveBeenCalledOnce();
    const [path, content] = mockWriteFile.mock.calls[0];
    expect(path).toBe("/tmp/fc-proxy-vm-test.conf");

    // Check SNI ACLs
    expect(content).toContain("ssl::server_name github.com");
    expect(content).toContain("ssl::server_name registry.npmjs.org");

    // Check splice and terminate
    expect(content).toContain("ssl_bump splice");
    expect(content).toContain("ssl_bump terminate all");
  });

  it("wildcard domains produce regex ACLs", async () => {
    const domains = ["*.npmjs.org", "*.github.com"];
    await startEgressProxy("vm-test", domains);

    const content = mockWriteFile.mock.calls[0][1] as string;
    // Wildcards should use ssl::server_name_regex
    expect(content).toContain("ssl::server_name_regex");
    expect(content).toContain("\\.npmjs\\.org$");
    expect(content).toContain("\\.github\\.com$");
  });

  it("non-wildcard domains produce exact ACLs", async () => {
    const domains = ["github.com"];
    await startEgressProxy("vm-test", domains);

    const content = mockWriteFile.mock.calls[0][1] as string;
    expect(content).toContain("ssl::server_name github.com");
    expect(content).not.toContain("ssl::server_name_regex.*github\\.com");
  });

  it("port is deterministic from vmId (13000 + hash % 1000)", async () => {
    const handle1 = await startEgressProxy("vm-aaa", ["example.com"]);
    vi.clearAllMocks();
    setupExecFileSuccess();
    const handle2 = await startEgressProxy("vm-aaa", ["example.com"]);

    // Same vmId → same port
    expect(handle1.port).toBe(handle2.port);
    expect(handle1.port).toBeGreaterThanOrEqual(13000);
    expect(handle1.port).toBeLessThan(14000);
  });
});

// ---------------------------------------------------------------------------
// Tests: applyProxyRedirect
// ---------------------------------------------------------------------------

describe("applyProxyRedirect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupExecFileSuccess();
  });

  it("adds PREROUTING REDIRECT rule for port 443", async () => {
    await applyProxyRedirect("fc-tap-abc", 13500);

    const calls = mockExecFile.mock.calls.filter(
      (c: unknown[]) => c[0] === "iptables",
    );
    expect(calls).toHaveLength(1);

    const args = (calls[0][1] as string[]).join(" ");
    expect(args).toContain("-t nat");
    expect(args).toContain("PREROUTING");
    expect(args).toContain("--dport 443");
    expect(args).toContain("REDIRECT");
    expect(args).toContain("--to-port 13500");
  });
});

// ---------------------------------------------------------------------------
// Tests: applyRateLimiting
// ---------------------------------------------------------------------------

describe("applyRateLimiting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupExecFileSuccess();
  });

  it("adds tc tbf + connlimit iptables rule", async () => {
    await applyRateLimiting("fc-tap-abc");

    const calls = mockExecFile.mock.calls.map((c: unknown[]) => ({
      cmd: c[0] as string,
      args: c[1] as string[],
    }));

    // tc qdisc add
    const tcCall = calls.find((c) => c.cmd === "tc");
    expect(tcCall).toBeDefined();
    expect(tcCall!.args.join(" ")).toContain("tbf");
    expect(tcCall!.args.join(" ")).toContain("10mbit");

    // connlimit iptables
    const iptablesCall = calls.find(
      (c) => c.cmd === "iptables" && c.args.join(" ").includes("connlimit"),
    );
    expect(iptablesCall).toBeDefined();
    expect(iptablesCall!.args.join(" ")).toContain("--connlimit-above 50");
  });
});

// ---------------------------------------------------------------------------
// Tests: stopEgressProxy
// ---------------------------------------------------------------------------

describe("stopEgressProxy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupExecFileSuccess();
  });

  it("kills process, removes all temp files", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    await stopEgressProxy({
      vmId: "vm-test",
      configPath: "/tmp/fc-proxy-vm-test.conf",
      pidFile: "/tmp/fc-proxy-vm-test.pid",
      port: 13500,
    });

    expect(killSpy).toHaveBeenCalledWith(54321, "SIGTERM");

    const unlinkPaths = mockUnlink.mock.calls.map((c: unknown[]) => c[0]);
    expect(unlinkPaths).toContain("/tmp/fc-proxy-vm-test.conf");
    expect(unlinkPaths).toContain("/tmp/fc-proxy-vm-test.pid");
    expect(unlinkPaths).toContain("/tmp/fc-proxy-vm-test.log");
    expect(unlinkPaths).toContain("/tmp/fc-proxy-vm-test-cache.log");

    killSpy.mockRestore();
  });
});
