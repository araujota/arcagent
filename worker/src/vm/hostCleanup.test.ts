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
const { mockExecFile } = vi.hoisted(() => {
  const mockExecFile = vi.fn();
  return { mockExecFile };
});

vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
}));

// ---------------------------------------------------------------------------
// Mock fs/promises
// ---------------------------------------------------------------------------
const { mockReaddir, mockUnlink } = vi.hoisted(() => ({
  mockReaddir: vi.fn(),
  mockUnlink: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  readdir: mockReaddir,
  unlink: mockUnlink,
}));

import { cleanupStaleResources } from "./hostCleanup";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupExecFile(responses: Record<string, { stdout: string; error?: boolean }>) {
  mockExecFile.mockImplementation(
    (cmd: string, args: string[], optsOrCb?: unknown, cb?: Function) => {
      const callback = typeof optsOrCb === "function" ? optsOrCb : cb;
      const key = `${cmd} ${(args || []).join(" ")}`;

      // Find matching response by prefix
      for (const [prefix, resp] of Object.entries(responses)) {
        if (key.startsWith(prefix)) {
          if (resp.error) {
            if (callback) callback(new Error("command failed"), { stdout: "", stderr: "" });
          } else {
            if (callback) callback(null, { stdout: resp.stdout, stderr: "" });
          }
          return { pid: 1 };
        }
      }
      // Default: success with empty output
      if (callback) callback(null, { stdout: "", stderr: "" });
      return { pid: 1 };
    },
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockReaddir.mockResolvedValue([]);
  mockUnlink.mockResolvedValue(undefined);
});

describe("cleanupStaleResources", () => {
  it("cleans up orphaned TAP devices", async () => {
    setupExecFile({
      "ip -o link show": {
        stdout: [
          "5: fc-tap-abc12345@if2: <BROADCAST,MULTICAST> mtu 1500 ...",
          "6: fc-tap-def67890@if3: <BROADCAST,MULTICAST> mtu 1500 ...",
          "7: eth0: <BROADCAST,MULTICAST,UP> mtu 1500 ...",
        ].join("\n"),
      },
    });

    await cleanupStaleResources();

    const calls = mockExecFile.mock.calls;
    const tapDelCalls = calls.filter(
      ([cmd, args]: [string, string[]]) =>
        cmd === "ip" && args?.includes("tuntap") && args?.includes("del"),
    );
    expect(tapDelCalls).toHaveLength(2);
    expect(tapDelCalls[0][1]).toContain("fc-tap-abc12345");
    expect(tapDelCalls[1][1]).toContain("fc-tap-def67890");
  });

  it("cleans up orphaned iptables FORWARD rules", async () => {
    setupExecFile({
      "ip -o link show": { stdout: "" },
      "iptables -S FORWARD": {
        stdout: [
          "-A FORWARD -i fc-tap-abc12345 -p tcp --dport 443 -j ACCEPT",
          "-A FORWARD -i fc-tap-abc12345 -j DROP",
          "-A FORWARD -i eth0 -j ACCEPT",
        ].join("\n"),
      },
    });

    await cleanupStaleResources();

    const calls = mockExecFile.mock.calls;
    const iptablesDel = calls.filter(
      ([cmd, args]: [string, string[]]) =>
        cmd === "iptables" && args?.[0] === "-D",
    );
    // Should delete the 2 fc-tap rules, not the eth0 rule
    expect(iptablesDel).toHaveLength(2);
  });

  it("cleans up orphaned loop devices", async () => {
    setupExecFile({
      "ip -o link show": { stdout: "" },
      "iptables -S FORWARD": { stdout: "" },
      "losetup -l -n -O NAME,BACK-FILE": {
        stdout: [
          "/dev/loop0 /tmp/fc-overlay-vm-abc12345.ext4",
          "/dev/loop1 /var/snap/something/else",
        ].join("\n"),
      },
    });

    await cleanupStaleResources();

    const calls = mockExecFile.mock.calls;
    const loopDetach = calls.filter(
      ([cmd, args]: [string, string[]]) =>
        cmd === "losetup" && args?.[0] === "-d",
    );
    expect(loopDetach).toHaveLength(1);
    expect(loopDetach[0][1]).toContain("/dev/loop0");
  });

  it("cleans up orphaned /tmp/fc-* files", async () => {
    mockReaddir.mockResolvedValue([
      "fc-overlay-vm-abc12345.ext4",
      "fc-config-vm-abc12345.json",
      "fc-vsock-vm-abc12345.sock",
      "fc-ssh-vm-abc12345",
      "unrelated-file.txt",
    ]);

    setupExecFile({
      "ip -o link show": { stdout: "" },
      "iptables -S FORWARD": { stdout: "" },
      "losetup -l -n -O NAME,BACK-FILE": { stdout: "" },
    });

    await cleanupStaleResources();

    expect(mockUnlink).toHaveBeenCalledTimes(4);
    expect(mockUnlink).toHaveBeenCalledWith("/tmp/fc-overlay-vm-abc12345.ext4");
    expect(mockUnlink).toHaveBeenCalledWith("/tmp/fc-config-vm-abc12345.json");
    expect(mockUnlink).toHaveBeenCalledWith("/tmp/fc-vsock-vm-abc12345.sock");
    expect(mockUnlink).toHaveBeenCalledWith("/tmp/fc-ssh-vm-abc12345");
  });

  it("handles all cleanup commands failing gracefully", async () => {
    setupExecFile({
      "ip -o link show": { stdout: "", error: true },
      "iptables -S FORWARD": { stdout: "", error: true },
      "losetup -l -n -O NAME,BACK-FILE": { stdout: "", error: true },
    });
    mockReaddir.mockRejectedValue(new Error("EACCES"));

    // Should not throw
    await expect(cleanupStaleResources()).resolves.toBeUndefined();
  });

  it("skips cleanup when no orphaned resources exist", async () => {
    setupExecFile({
      "ip -o link show": { stdout: "1: lo: ...\n2: eth0: ..." },
      "iptables -S FORWARD": { stdout: "-A FORWARD -j ACCEPT" },
      "losetup -l -n -O NAME,BACK-FILE": { stdout: "" },
    });
    mockReaddir.mockResolvedValue(["unrelated.txt"]);

    await cleanupStaleResources();

    // No TAP del, no iptables del, no losetup detach, no unlink
    const tapDel = mockExecFile.mock.calls.filter(
      ([cmd, args]: [string, string[]]) =>
        cmd === "ip" && args?.includes("del"),
    );
    expect(tapDel).toHaveLength(0);
    expect(mockUnlink).not.toHaveBeenCalled();
  });
});
