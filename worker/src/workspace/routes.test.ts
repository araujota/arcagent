import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import express from "express";
import supertest from "supertest";
import { createWorkspaceRoutes } from "./routes";
import { authMiddleware } from "../api/auth";
import {
  provisionWorkspace,
  getSession,
  destroyWorkspace,
  extractDiff,
  extendTTL,
  touchActivity,
} from "./sessionManager";
import { isBlockedCommand, validateWorkspacePath } from "./validation";
import { sessionStore } from "./sessionStore";

const sessionStoreGetMock = vi.spyOn(sessionStore, "get");

// ---------------------------------------------------------------------------
// Mock logger (imported by routes.ts via ../index)
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
// Mock sessionManager
// ---------------------------------------------------------------------------
vi.mock("./sessionManager", () => ({
  provisionWorkspace: vi.fn(),
  getSession: vi.fn(),
  destroyWorkspace: vi.fn(),
  extractDiff: vi.fn(),
  extendTTL: vi.fn(),
  touchActivity: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock validation
// ---------------------------------------------------------------------------
vi.mock("./validation", () => ({
  isBlockedCommand: vi.fn().mockReturnValue(false),
  validateWorkspacePath: vi
    .fn()
    .mockImplementation((p: string) => `/workspace/${p}`),
  shellEscape: vi.fn().mockImplementation((s: string) => `'${s}'`),
  validateGlobPattern: vi.fn().mockImplementation((p: string) => p),
}));

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------
beforeAll(() => {
  process.env.WORKER_SHARED_SECRET = "test-secret";
});

// ---------------------------------------------------------------------------
// Test app factory — mirrors production wiring in index.ts
// ---------------------------------------------------------------------------
function createTestApp() {
  const app = express();
  app.use(express.json({ limit: "12mb" }));
  // Auth middleware is applied at the app level in production (index.ts),
  // so we wire it here to test the full request pipeline.
  app.use(authMiddleware);
  app.use(createWorkspaceRoutes());
  return app;
}

const AUTH_HEADER = "Bearer test-secret";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReadySession(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: "ws-1",
    status: "ready",
    language: "typescript",
    createdAt: Date.now() - 60_000,
    readyAt: Date.now() - 30_000,
    expiresAt: Date.now() + 3_600_000,
    lastActivityAt: Date.now(),
    errorMessage: undefined,
    vmHandle: {
      vmId: "vm-123",
      exec: vi.fn().mockResolvedValue({
        stdout: "hello\n",
        stderr: "",
        exitCode: 0,
      }),
      readFile: vi.fn().mockResolvedValue(Buffer.from("file content")),
      writeFile: vi.fn().mockResolvedValue(undefined),
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  // Restore default mock implementations after clearAllMocks
  process.env.WORKER_ROLE = "api";
  sessionStoreGetMock.mockResolvedValue(null);
  vi.mocked(isBlockedCommand).mockReturnValue(false);
  vi.mocked(validateWorkspacePath).mockImplementation(
    (p: string) => `/workspace/${p}`,
  );
});

// ---------------------------------------------------------------------------
// POST /workspace/provision
// ---------------------------------------------------------------------------

describe("POST /workspace/provision", () => {
  const validBody = {
    workspaceId: "ws-1",
    claimId: "claim-1",
    bountyId: "bounty-1",
    agentId: "agent-1",
    repoUrl: "https://github.com/org/repo.git",
    commitSha: "abc123",
  };

  it("provisions workspace with valid inputs", async () => {
    const mockSession = makeReadySession();
    vi.mocked(provisionWorkspace).mockResolvedValue(mockSession as never);

    const res = await supertest(createTestApp())
      .post("/workspace/provision")
      .set("Authorization", AUTH_HEADER)
      .send(validBody);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      workspaceId: "ws-1",
      vmId: "vm-123",
      status: "ready",
    });
    expect(provisionWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        claimId: "claim-1",
        bountyId: "bounty-1",
        agentId: "agent-1",
        repoUrl: "https://github.com/org/repo.git",
        commitSha: "abc123",
        language: "typescript", // default
      }),
    );
  });

  it("rejects without auth", async () => {
    const res = await supertest(createTestApp())
      .post("/workspace/provision")
      .send(validBody);

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Authorization/i);
  });

  it("returns 400 for missing required fields", async () => {
    const res = await supertest(createTestApp())
      .post("/workspace/provision")
      .set("Authorization", AUTH_HEADER)
      .send({ claimId: "claim-1" }); // missing workspaceId and others

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Missing required fields/);
  });

  it("returns 403 for wrong auth token", async () => {
    const res = await supertest(createTestApp())
      .post("/workspace/provision")
      .set("Authorization", "Bearer wrong-token")
      .send(validBody);

    expect(res.status).toBe(403);
  });

  it("defaults language to typescript and expiresAt to ~4h from now", async () => {
    const mockSession = makeReadySession();
    vi.mocked(provisionWorkspace).mockResolvedValue(mockSession as never);

    await supertest(createTestApp())
      .post("/workspace/provision")
      .set("Authorization", AUTH_HEADER)
      .send(validBody);

    const call = vi.mocked(provisionWorkspace).mock.calls[0]![0] as {
      language: string;
      expiresAt: number;
    };
    expect(call.language).toBe("typescript");
    // expiresAt should be roughly 4 hours from now
    const fourHoursMs = 4 * 60 * 60 * 1000;
    expect(call.expiresAt).toBeGreaterThan(Date.now() + fourHoursMs - 10_000);
    expect(call.expiresAt).toBeLessThanOrEqual(Date.now() + fourHoursMs + 5_000);
  });
});

// ---------------------------------------------------------------------------
// POST /workspace/exec
// ---------------------------------------------------------------------------

describe("POST /workspace/exec", () => {
  it("executes command in workspace", async () => {
    const session = makeReadySession();
    vi.mocked(getSession).mockReturnValue(session as never);

    const res = await supertest(createTestApp())
      .post("/workspace/exec")
      .set("Authorization", AUTH_HEADER)
      .send({ workspaceId: "ws-1", command: "echo hello" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      stdout: "hello\n",
      stderr: "",
      exitCode: 0,
    });
    expect(session.vmHandle.exec).toHaveBeenCalledWith(
      "echo hello",
      expect.any(Number),
      "agent",
    );
    expect(touchActivity).toHaveBeenCalledWith("ws-1");
  });

  it("blocks dangerous commands", async () => {
    vi.mocked(isBlockedCommand).mockReturnValue(true);

    const res = await supertest(createTestApp())
      .post("/workspace/exec")
      .set("Authorization", AUTH_HEADER)
      .send({ workspaceId: "ws-1", command: "poweroff" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not allowed/i);
  });

  it("clamps timeout to 300s", async () => {
    const session = makeReadySession();
    vi.mocked(getSession).mockReturnValue(session as never);

    await supertest(createTestApp())
      .post("/workspace/exec")
      .set("Authorization", AUTH_HEADER)
      .send({ workspaceId: "ws-1", command: "sleep 1", timeoutMs: 999_999 });

    const calledTimeout = session.vmHandle.exec.mock.calls[0]![1] as number;
    expect(calledTimeout).toBeLessThanOrEqual(300_000);
  });

  it("returns 400 for missing command", async () => {
    const res = await supertest(createTestApp())
      .post("/workspace/exec")
      .set("Authorization", AUTH_HEADER)
      .send({ workspaceId: "ws-1" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Missing/);
  });

  it("returns 404 when workspace not found", async () => {
    vi.mocked(getSession).mockReturnValue(undefined as never);

    const res = await supertest(createTestApp())
      .post("/workspace/exec")
      .set("Authorization", AUTH_HEADER)
      .send({ workspaceId: "ws-nonexistent", command: "echo hi" });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it("uses default timeout of 120s when timeoutMs is omitted", async () => {
    const session = makeReadySession();
    vi.mocked(getSession).mockReturnValue(session as never);

    await supertest(createTestApp())
      .post("/workspace/exec")
      .set("Authorization", AUTH_HEADER)
      .send({ workspaceId: "ws-1", command: "ls" });

    const calledTimeout = session.vmHandle.exec.mock.calls[0]![1] as number;
    expect(calledTimeout).toBe(120_000);
  });
});

// ---------------------------------------------------------------------------
// POST /workspace/read-file
// ---------------------------------------------------------------------------

describe("POST /workspace/read-file", () => {
  it("reads file with validated path", async () => {
    const session = makeReadySession();
    // Single exec call returns JSON with binary check, line count, and base64 content
    const content = Buffer.from("line 1\nline 2\n").toString("base64");
    session.vmHandle.exec.mockResolvedValueOnce({
      stdout: `{"binary":false,"totalLines":42,"content":"${content}"}`,
      stderr: "",
      exitCode: 0,
    });
    vi.mocked(getSession).mockReturnValue(session as never);

    const res = await supertest(createTestApp())
      .post("/workspace/read-file")
      .set("Authorization", AUTH_HEADER)
      .send({ workspaceId: "ws-1", path: "src/index.ts" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      content: "line 1\nline 2\n",
      isBinary: false,
      totalLines: 42,
    });
    expect(validateWorkspacePath).toHaveBeenCalledWith("src/index.ts");
    expect(touchActivity).toHaveBeenCalledWith("ws-1");
    // Only 1 exec call (combined), not 3
    expect(session.vmHandle.exec).toHaveBeenCalledTimes(1);
  });

  it("rejects path traversal", async () => {
    vi.mocked(validateWorkspacePath).mockImplementation(() => {
      throw new Error("Path must be within /workspace/");
    });
    const session = makeReadySession();
    vi.mocked(getSession).mockReturnValue(session as never);

    const res = await supertest(createTestApp())
      .post("/workspace/read-file")
      .set("Authorization", AUTH_HEADER)
      .send({ workspaceId: "ws-1", path: "../etc/passwd" });

    // The error is caught by the try/catch, which returns 500
    // because validateWorkspacePath throws a generic Error
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Path must be within/);
  });

  it("detects binary files", async () => {
    const session = makeReadySession();
    // Single exec call returns JSON indicating binary
    session.vmHandle.exec.mockResolvedValueOnce({
      stdout: '{"binary":true}',
      stderr: "",
      exitCode: 0,
    });
    vi.mocked(getSession).mockReturnValue(session as never);

    const res = await supertest(createTestApp())
      .post("/workspace/read-file")
      .set("Authorization", AUTH_HEADER)
      .send({ workspaceId: "ws-1", path: "image.png" });

    expect(res.status).toBe(200);
    expect(res.body.isBinary).toBe(true);
    expect(res.body.content).toMatch(/Binary file/);
  });

  it("returns 400 for missing path", async () => {
    const res = await supertest(createTestApp())
      .post("/workspace/read-file")
      .set("Authorization", AUTH_HEADER)
      .send({ workspaceId: "ws-1" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Missing/);
  });
});

// ---------------------------------------------------------------------------
// POST /workspace/write-file
// ---------------------------------------------------------------------------

describe("POST /workspace/write-file", () => {
  it("writes file successfully", async () => {
    const session = makeReadySession();
    vi.mocked(getSession).mockReturnValue(session as never);

    const res = await supertest(createTestApp())
      .post("/workspace/write-file")
      .set("Authorization", AUTH_HEADER)
      .send({
        workspaceId: "ws-1",
        path: "src/app.ts",
        content: 'console.log("hello");',
      });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      bytesWritten: expect.any(Number),
      path: "/workspace/src/app.ts",
    });
    expect(session.vmHandle.writeFile).toHaveBeenCalledWith(
      "/workspace/src/app.ts",
      expect.any(Buffer),
      "0644",
      "agent:agent",
    );
    expect(touchActivity).toHaveBeenCalledWith("ws-1");
  });

  it("rejects oversized content (>1MB)", async () => {
    const oversizedContent = "x".repeat(1024 * 1024 + 1);

    const res = await supertest(createTestApp())
      .post("/workspace/write-file")
      .set("Authorization", AUTH_HEADER)
      .send({
        workspaceId: "ws-1",
        path: "big-file.txt",
        content: oversizedContent,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/too large/i);
  });

  it("returns 400 for missing content", async () => {
    const res = await supertest(createTestApp())
      .post("/workspace/write-file")
      .set("Authorization", AUTH_HEADER)
      .send({ workspaceId: "ws-1", path: "file.txt" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Missing/);
  });

  it("returns 404 when workspace not found", async () => {
    vi.mocked(getSession).mockReturnValue(undefined as never);

    const res = await supertest(createTestApp())
      .post("/workspace/write-file")
      .set("Authorization", AUTH_HEADER)
      .send({
        workspaceId: "ws-missing",
        path: "file.txt",
        content: "data",
      });

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /workspace/diff
// ---------------------------------------------------------------------------

describe("POST /workspace/diff", () => {
  it("returns diff output", async () => {
    const session = makeReadySession();
    vi.mocked(getSession).mockReturnValue(session as never);

    const mockDiff = {
      diffPatch: "--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new",
      diffStat: " 1 file changed, 1 insertion(+), 1 deletion(-)",
      changedFiles: ["file.ts"],
      hasChanges: true,
    };
    vi.mocked(extractDiff).mockResolvedValue(mockDiff as never);

    const res = await supertest(createTestApp())
      .post("/workspace/diff")
      .set("Authorization", AUTH_HEADER)
      .send({ workspaceId: "ws-1" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      diffPatch: expect.stringContaining("file.ts"),
      hasChanges: true,
      changedFiles: ["file.ts"],
    });
    expect(extractDiff).toHaveBeenCalledWith("ws-1");
    expect(touchActivity).toHaveBeenCalledWith("ws-1");
  });

  it("returns 400 for missing workspaceId", async () => {
    const res = await supertest(createTestApp())
      .post("/workspace/diff")
      .set("Authorization", AUTH_HEADER)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Missing/);
  });

  it("returns 404 when workspace not found", async () => {
    vi.mocked(getSession).mockReturnValue(undefined as never);

    const res = await supertest(createTestApp())
      .post("/workspace/diff")
      .set("Authorization", AUTH_HEADER)
      .send({ workspaceId: "ws-gone" });

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /workspace/status
// ---------------------------------------------------------------------------

describe("POST /workspace/status", () => {
  it("returns session metadata", async () => {
    const session = makeReadySession({
      language: "python",
    });
    vi.mocked(getSession).mockReturnValue(session as never);

    const res = await supertest(createTestApp())
      .post("/workspace/status")
      .set("Authorization", AUTH_HEADER)
      .send({ workspaceId: "ws-1" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      workspaceId: "ws-1",
      status: "ready",
      vmId: "vm-123",
      language: "python",
    });
    expect(res.body.createdAt).toBeDefined();
    expect(res.body.expiresAt).toBeDefined();
  });

  it("returns 404 if workspace not found", async () => {
    vi.mocked(getSession).mockReturnValue(undefined as never);

    const res = await supertest(createTestApp())
      .post("/workspace/status")
      .set("Authorization", AUTH_HEADER)
      .send({ workspaceId: "ws-missing" });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it("returns 400 for missing workspaceId", async () => {
    const res = await supertest(createTestApp())
      .post("/workspace/status")
      .set("Authorization", AUTH_HEADER)
      .send({});

    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /workspace/destroy
// ---------------------------------------------------------------------------

describe("POST /workspace/destroy", () => {
  it("destroys workspace", async () => {
    vi.mocked(destroyWorkspace).mockResolvedValue(undefined as never);

    const res = await supertest(createTestApp())
      .post("/workspace/destroy")
      .set("Authorization", AUTH_HEADER)
      .send({ workspaceId: "ws-1" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true });
    expect(destroyWorkspace).toHaveBeenCalledWith("ws-1", "api_request");
  });

  it("passes custom reason", async () => {
    vi.mocked(destroyWorkspace).mockResolvedValue(undefined as never);

    await supertest(createTestApp())
      .post("/workspace/destroy")
      .set("Authorization", AUTH_HEADER)
      .send({ workspaceId: "ws-1", reason: "timeout" });

    expect(destroyWorkspace).toHaveBeenCalledWith("ws-1", "timeout");
  });

  it("returns 400 for missing workspaceId", async () => {
    const res = await supertest(createTestApp())
      .post("/workspace/destroy")
      .set("Authorization", AUTH_HEADER)
      .send({});

    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /workspace/extend-ttl
// ---------------------------------------------------------------------------

describe("POST /workspace/extend-ttl", () => {
  it("extends TTL successfully", async () => {
    vi.mocked(extendTTL).mockReturnValue(undefined as never);

    const newExpiry = Date.now() + 7_200_000;
    const res = await supertest(createTestApp())
      .post("/workspace/extend-ttl")
      .set("Authorization", AUTH_HEADER)
      .send({ workspaceId: "ws-1", newExpiresAt: newExpiry });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      expiresAt: newExpiry,
    });
    expect(extendTTL).toHaveBeenCalledWith("ws-1", newExpiry);
  });

  it("returns 400 for missing newExpiresAt", async () => {
    const res = await supertest(createTestApp())
      .post("/workspace/extend-ttl")
      .set("Authorization", AUTH_HEADER)
      .send({ workspaceId: "ws-1" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Missing/);
  });

  it("returns 400 for missing workspaceId", async () => {
    const res = await supertest(createTestApp())
      .post("/workspace/extend-ttl")
      .set("Authorization", AUTH_HEADER)
      .send({ newExpiresAt: Date.now() + 3600_000 });

    expect(res.status).toBe(400);
  });
});
