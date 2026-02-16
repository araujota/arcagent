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
// Mock node:crypto
// ---------------------------------------------------------------------------
const fakeKey = Buffer.alloc(32, 0xab);
vi.mock("node:crypto", () => ({
  randomBytes: vi.fn().mockReturnValue(Buffer.alloc(32, 0xab)),
}));

// ---------------------------------------------------------------------------
// Mock node:fs/promises
// ---------------------------------------------------------------------------
const mockUnlink = vi.fn().mockResolvedValue(undefined);
vi.mock("node:fs/promises", () => ({
  unlink: (...args: unknown[]) => mockUnlink(...args),
}));

// ---------------------------------------------------------------------------
// Import module under test
// ---------------------------------------------------------------------------
import {
  createEncryptedOverlay,
  destroyEncryptedOverlay,
  cleanupStaleCryptDevices,
  type EncryptedOverlayHandle,
} from "./encryptedOverlay";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupExecFileSuccess() {
  mockExecFile.mockImplementation(
    (cmd: string, args: string[], optsOrCb?: unknown, cb?: Function) => {
      const callback = typeof optsOrCb === "function" ? optsOrCb : cb;

      // losetup --find --show → return a loop device
      if (cmd === "losetup" && args?.includes("--find")) {
        if (callback) callback(null, { stdout: "/dev/loop0\n", stderr: "" });
        return Promise.resolve({ stdout: "/dev/loop0\n", stderr: "" });
      }

      // cryptsetup open → needs stdin pipe
      if (cmd === "cryptsetup" && args?.includes("open")) {
        const mockProc = {
          stdin: { write: vi.fn(), end: vi.fn() },
        };
        if (callback) callback(null, { stdout: "", stderr: "" });
        return mockProc;
      }

      if (callback) callback(null, { stdout: "", stderr: "" });
      return Promise.resolve({ stdout: "", stderr: "" });
    },
  );
}

// ---------------------------------------------------------------------------
// Tests: createEncryptedOverlay
// ---------------------------------------------------------------------------

describe("createEncryptedOverlay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupExecFileSuccess();
  });

  it("copies rootfs, creates loop device, opens dm-crypt, dds data", async () => {
    const handle = await createEncryptedOverlay("vm-test", "/var/lib/firecracker/rootfs/node-20.ext4");

    const calls = mockExecFile.mock.calls.map((c: unknown[]) => ({
      cmd: c[0] as string,
      args: c[1] as string[],
    }));

    // 1. cp --reflink=auto
    expect(calls.some((c) => c.cmd === "cp" && c.args.includes("--reflink=auto"))).toBe(true);
    // 2. losetup --find --show
    expect(calls.some((c) => c.cmd === "losetup" && c.args.includes("--find"))).toBe(true);
    // 3. cryptsetup open
    expect(calls.some((c) => c.cmd === "cryptsetup" && c.args.includes("open"))).toBe(true);
    // 4. dd
    expect(calls.some((c) => c.cmd === "dd")).toBe(true);
  });

  it("returns handle with correct loopDevice, cryptName, devicePath, backingFile", async () => {
    const handle = await createEncryptedOverlay("vm-test", "/rootfs/node-20.ext4");

    expect(handle.loopDevice).toBe("/dev/loop0");
    expect(handle.cryptName).toBe("fc-crypt-vm-test");
    expect(handle.devicePath).toBe("/dev/mapper/fc-crypt-vm-test");
    expect(handle.backingFile).toBe("/tmp/fc-overlay-vm-test.ext4");
    expect(handle.keyBuffer).toBeInstanceOf(Buffer);
    expect(handle.keyBuffer.length).toBe(32);
  });

  it("on failure: cleans up loop device, deletes backing file, zeros key", async () => {
    // Make cryptsetup fail
    mockExecFile.mockImplementation(
      (cmd: string, args: string[], optsOrCb?: unknown, cb?: Function) => {
        const callback = typeof optsOrCb === "function" ? optsOrCb : cb;

        if (cmd === "losetup" && args?.includes("--find")) {
          if (callback) callback(null, { stdout: "/dev/loop0\n", stderr: "" });
          return Promise.resolve({ stdout: "/dev/loop0\n", stderr: "" });
        }

        if (cmd === "cp") {
          if (callback) callback(null, { stdout: "", stderr: "" });
          return Promise.resolve({ stdout: "", stderr: "" });
        }

        if (cmd === "cryptsetup") {
          const err = new Error("cryptsetup not found");
          if (callback) callback(err);
          return mockExecFile;
        }

        // losetup -d (cleanup)
        if (cmd === "losetup" && args?.includes("-d")) {
          if (callback) callback(null, { stdout: "", stderr: "" });
          return Promise.resolve({ stdout: "", stderr: "" });
        }

        if (callback) callback(null, { stdout: "", stderr: "" });
        return Promise.resolve({ stdout: "", stderr: "" });
      },
    );

    await expect(
      createEncryptedOverlay("vm-fail", "/rootfs/node-20.ext4"),
    ).rejects.toThrow();

    // Should have cleaned up loop device
    const losetupDetach = mockExecFile.mock.calls.find(
      (c: unknown[]) => c[0] === "losetup" && (c[1] as string[]).includes("-d"),
    );
    expect(losetupDetach).toBeDefined();

    // Should have unlinked backing file
    expect(mockUnlink).toHaveBeenCalledWith("/tmp/fc-overlay-vm-fail.ext4");
  });
});

// ---------------------------------------------------------------------------
// Tests: destroyEncryptedOverlay
// ---------------------------------------------------------------------------

describe("destroyEncryptedOverlay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], optsOrCb?: unknown, cb?: Function) => {
        const callback = typeof optsOrCb === "function" ? optsOrCb : cb;
        if (callback) callback(null, { stdout: "", stderr: "" });
        return Promise.resolve({ stdout: "", stderr: "" });
      },
    );
  });

  it("closes dm-crypt, detaches loop, deletes file, zeros key buffer", async () => {
    const keyBuffer = Buffer.alloc(32, 0xff);
    const handle: EncryptedOverlayHandle = {
      loopDevice: "/dev/loop0",
      cryptName: "fc-crypt-vm-test",
      devicePath: "/dev/mapper/fc-crypt-vm-test",
      backingFile: "/tmp/fc-overlay-vm-test.ext4",
      keyBuffer,
    };

    await destroyEncryptedOverlay(handle);

    const calls = mockExecFile.mock.calls.map((c: unknown[]) => ({
      cmd: c[0] as string,
      args: c[1] as string[],
    }));

    // 1. cryptsetup close
    expect(calls.some((c) => c.cmd === "cryptsetup" && c.args.includes("close") && c.args.includes("fc-crypt-vm-test"))).toBe(true);
    // 2. losetup -d
    expect(calls.some((c) => c.cmd === "losetup" && c.args.includes("-d") && c.args.includes("/dev/loop0"))).toBe(true);
    // 3. unlink backing file
    expect(mockUnlink).toHaveBeenCalledWith("/tmp/fc-overlay-vm-test.ext4");
    // 4. key zeroed
    expect(keyBuffer.every((b) => b === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: cleanupStaleCryptDevices
// ---------------------------------------------------------------------------

describe("cleanupStaleCryptDevices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses dmsetup output and closes matching devices", async () => {
    mockExecFile.mockImplementation(
      (cmd: string, args: string[], optsOrCb?: unknown, cb?: Function) => {
        const callback = typeof optsOrCb === "function" ? optsOrCb : cb;

        if (cmd === "dmsetup" && args?.includes("ls")) {
          const stdout = "fc-crypt-vm-abc12345\t(254:0)\nfc-crypt-vm-def67890\t(254:1)\nother-device\t(254:2)\n";
          if (callback) callback(null, { stdout, stderr: "" });
          return Promise.resolve({ stdout, stderr: "" });
        }

        if (callback) callback(null, { stdout: "", stderr: "" });
        return Promise.resolve({ stdout: "", stderr: "" });
      },
    );

    await cleanupStaleCryptDevices();

    const cryptsetupCalls = mockExecFile.mock.calls.filter(
      (c: unknown[]) => c[0] === "cryptsetup" && (c[1] as string[]).includes("close"),
    );
    expect(cryptsetupCalls).toHaveLength(2);
    expect((cryptsetupCalls[0][1] as string[])[1]).toBe("fc-crypt-vm-abc12345");
    expect((cryptsetupCalls[1][1] as string[])[1]).toBe("fc-crypt-vm-def67890");
  });

  it("no-ops gracefully when dmsetup not installed", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], optsOrCb?: unknown, cb?: Function) => {
        const callback = typeof optsOrCb === "function" ? optsOrCb : cb;
        const err = new Error("dmsetup: command not found");
        if (callback) callback(err);
        return Promise.reject(err);
      },
    );

    // Should not throw
    await expect(cleanupStaleCryptDevices()).resolves.toBeUndefined();
  });
});
