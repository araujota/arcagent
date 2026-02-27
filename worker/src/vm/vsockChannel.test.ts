import { describe, it, expect, afterEach, vi } from "vitest";
import { createServer, Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";
import type { VsockRequest, VsockResponse } from "./vsockChannel";

// ---------------------------------------------------------------------------
// Mock logger (imported by vsockChannel via ../index)
// ---------------------------------------------------------------------------
vi.mock("../index", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Import after mocks
import { vsockExec, vsockExecWithStdin, vsockWriteFile, waitForVsock } from "./vsockChannel";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let servers: Server[] = [];

function socketPath(): string {
  return join(tmpdir(), `vsock-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sock`);
}

/**
 * Create a mock guest agent that speaks the length-prefixed JSON protocol.
 * The handler receives a parsed VsockRequest and returns a VsockResponse.
 */
function createMockGuestAgent(
  path: string,
  handler: (req: VsockRequest) => VsockResponse,
): Server {
  const server = createServer((socket) => {
    const chunks: Buffer[] = [];
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      if (buf.length < 4) return;
      const len = buf.readUInt32BE(0);
      if (buf.length < 4 + len) return;
      const req: VsockRequest = JSON.parse(
        buf.subarray(4, 4 + len).toString("utf-8"),
      );
      const res = handler(req);
      const payload = Buffer.from(JSON.stringify(res), "utf-8");
      const header = Buffer.alloc(4);
      header.writeUInt32BE(payload.length, 0);
      socket.write(Buffer.concat([header, payload]));
      socket.end();
    });
  });
  server.listen(path);
  servers.push(server);
  return server;
}

afterEach(() => {
  for (const s of servers) {
    try {
      const addr = s.address();
      s.close();
      if (typeof addr === "string") {
        try { unlinkSync(addr); } catch {}
      }
    } catch {}
  }
  servers = [];
});

// ---------------------------------------------------------------------------
// vsockExec
// ---------------------------------------------------------------------------

describe("vsockExec", () => {
  it("sends correct request and parses exec result", async () => {
    const sock = socketPath();
    createMockGuestAgent(sock, (req) => {
      expect(req.type).toBe("exec");
      expect(req.command).toBe("ls -la");
      return { type: "exec_result", stdout: "file.txt\n", stderr: "", exitCode: 0 };
    });

    const result = await vsockExec(sock, "ls -la", 5_000);
    expect(result.stdout).toBe("file.txt\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("passes user parameter when provided", async () => {
    const sock = socketPath();
    let receivedUser: string | undefined;
    createMockGuestAgent(sock, (req) => {
      receivedUser = req.user;
      return { type: "exec_result", stdout: "", stderr: "", exitCode: 0 };
    });

    await vsockExec(sock, "whoami", 5_000, "agent");
    expect(receivedUser).toBe("agent");
  });

  it("returns exitCode from guest response", async () => {
    const sock = socketPath();
    createMockGuestAgent(sock, () => {
      return { type: "exec_result", stdout: "", stderr: "not found", exitCode: 127 };
    });

    const result = await vsockExec(sock, "nonexistent", 5_000);
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toBe("not found");
  });

  it("times out when guest doesn't respond", async () => {
    const sock = socketPath();
    // Create a server that accepts but never replies
    const server = createServer((_socket) => {
      // intentionally silent
    });
    server.listen(sock);
    servers.push(server);

    // Source adds CONNECT_TIMEOUT_MS (10s) to user timeout, so 200ms → 10200ms actual
    await expect(vsockExec(sock, "hang", 200)).rejects.toThrow(/timed out/);
  }, 15_000);
});

// ---------------------------------------------------------------------------
// vsockExecWithStdin
// ---------------------------------------------------------------------------

describe("vsockExecWithStdin", () => {
  it("sends stdin data in the request payload", async () => {
    const sock = socketPath();
    let receivedStdin: string | undefined;
    createMockGuestAgent(sock, (req) => {
      expect(req.type).toBe("exec_with_stdin");
      receivedStdin = req.stdin;
      return { type: "exec_result", stdout: "3\n", stderr: "", exitCode: 0 };
    });

    const result = await vsockExecWithStdin(sock, "wc -l", "a\nb\nc\n", 5_000);
    expect(receivedStdin).toBe("a\nb\nc\n");
    expect(result.stdout).toBe("3\n");
    expect(result.exitCode).toBe(0);
  });

  it("returns exec result correctly", async () => {
    const sock = socketPath();
    createMockGuestAgent(sock, () => {
      return {
        type: "exec_result",
        stdout: "processed",
        stderr: "warning: thing",
        exitCode: 0,
      };
    });

    const result = await vsockExecWithStdin(sock, "process", "input", 5_000);
    expect(result.stdout).toBe("processed");
    expect(result.stderr).toBe("warning: thing");
  });
});

// ---------------------------------------------------------------------------
// vsockWriteFile
// ---------------------------------------------------------------------------

describe("vsockWriteFile", () => {
  it("sends base64-encoded content, path, mode, owner", async () => {
    const sock = socketPath();
    let receivedReq: VsockRequest | undefined;
    createMockGuestAgent(sock, (req) => {
      receivedReq = req;
      return { type: "file_result" };
    });

    const content = Buffer.from("#!/bin/bash\necho hello");
    await vsockWriteFile(sock, "/tmp/test.sh", content, "0755", "root:root");

    expect(receivedReq!.type).toBe("file_write");
    expect(receivedReq!.path).toBe("/tmp/test.sh");
    expect(receivedReq!.contentBase64).toBe(content.toString("base64"));
    expect(receivedReq!.mode).toBe("0755");
    expect(receivedReq!.owner).toBe("root:root");
  });

  it("throws when guest returns error response", async () => {
    const sock = socketPath();
    createMockGuestAgent(sock, () => {
      return { type: "error", error: "permission denied" };
    });

    await expect(
      vsockWriteFile(sock, "/root/secret", Buffer.from("x")),
    ).rejects.toThrow(/permission denied/);
  });
});

// ---------------------------------------------------------------------------
// waitForVsock
// ---------------------------------------------------------------------------

describe("waitForVsock", () => {
  it('resolves immediately when guest is ready (echo ok → exitCode 0, stdout "ok")', async () => {
    const sock = socketPath();
    createMockGuestAgent(sock, () => {
      return { type: "exec_result", stdout: "ok\n", stderr: "", exitCode: 0 };
    });

    await expect(waitForVsock(sock, "vm-test", 5, 10)).resolves.toBeUndefined();
  });

  it("retries with backoff when initial connections fail then succeeds", async () => {
    const sock = socketPath();
    let attempt = 0;

    // Start a server that fails the first 2 attempts, then succeeds
    createMockGuestAgent(sock, () => {
      attempt++;
      if (attempt <= 2) {
        return { type: "exec_result", stdout: "nope", stderr: "", exitCode: 1 };
      }
      return { type: "exec_result", stdout: "ok\n", stderr: "", exitCode: 0 };
    });

    // waitForVsock checks exitCode === 0 && stdout.trim() === "ok"
    // Failed exitCode or wrong stdout causes retry via catch, but actually
    // looking at the source, non-zero exit or wrong stdout just silently
    // loops without throw, so it will keep retrying.
    await expect(waitForVsock(sock, "vm-test", 10, 10)).resolves.toBeUndefined();
    expect(attempt).toBeGreaterThanOrEqual(3);
  });

  it("throws after maxRetries exceeded", async () => {
    const sock = socketPath();
    // Server that never returns "ok"
    createMockGuestAgent(sock, () => {
      return { type: "exec_result", stdout: "not ready", stderr: "", exitCode: 1 };
    });

    await expect(waitForVsock(sock, "vm-retry", 3, 10)).rejects.toThrow(
      /Vsock not reachable for VM vm-retry after 3 retries; lastError=/,
    );
  });

  it("handles connection refused gracefully (no socket listening)", async () => {
    const sock = socketPath(); // no server listening

    await expect(waitForVsock(sock, "vm-noconn", 2, 10)).rejects.toThrow(
      /Vsock not reachable.*lastError=/,
    );
  });
});

// ---------------------------------------------------------------------------
// Framing edge cases
// ---------------------------------------------------------------------------

describe("framing edge cases", () => {
  it("handles large payloads (100KB stdout)", async () => {
    const sock = socketPath();
    const largeOutput = "x".repeat(100 * 1024);
    createMockGuestAgent(sock, () => {
      return { type: "exec_result", stdout: largeOutput, stderr: "", exitCode: 0 };
    });

    const result = await vsockExec(sock, "generate", 10_000);
    expect(result.stdout).toBe(largeOutput);
    expect(result.stdout.length).toBe(100 * 1024);
  });

  it("handles empty stdout/stderr fields", async () => {
    const sock = socketPath();
    createMockGuestAgent(sock, () => {
      // Guest omits stdout/stderr entirely
      return { type: "exec_result", exitCode: 0 } as VsockResponse;
    });

    const result = await vsockExec(sock, "silent", 5_000);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });
});
