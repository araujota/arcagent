/**
 * End-to-end agent flow tests.
 *
 * Simulates the full lifecycle an agent experiences:
 *   1. Convex calls POST /workspace/provision (on claim creation)
 *   2. Agent polls POST /workspace/status (until ready)
 *   3. Agent uses workspace_exec, read-file, write-file, batch-read,
 *      batch-write, search, list-files, exec-stream
 *   4. Agent calls submit_solution → POST /workspace/diff
 *   5. Workspace destroyed on TTL/release
 *
 * Tests use supertest against the Express router with mocked sessionManager
 * and validation — same approach as routes.test.ts.
 */

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

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../index", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("./sessionManager", () => ({
  provisionWorkspace: vi.fn(),
  getSession: vi.fn(),
  destroyWorkspace: vi.fn(),
  extractDiff: vi.fn(),
  extendTTL: vi.fn(),
  touchActivity: vi.fn(),
}));

vi.mock("./validation", () => ({
  isBlockedCommand: vi.fn().mockReturnValue(false),
  validateWorkspacePath: vi
    .fn()
    .mockImplementation((p: string) => `/workspace/${p}`),
  shellEscape: vi.fn().mockImplementation((s: string) => `'${s}'`),
  validateGlobPattern: vi.fn().mockImplementation((p: string) => p),
}));

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(() => {
  process.env.WORKER_SHARED_SECRET = "test-secret";
  process.env.WORKER_HOST_URL = "http://10.1.1.100:3001";
});

const AUTH_HEADER = "Bearer test-secret";

function createTestApp() {
  const app = express();
  app.use(express.json({ limit: "12mb" }));
  app.use(authMiddleware);
  app.use(createWorkspaceRoutes());
  return app;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReadySession(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: "ws-flow-test",
    status: "ready",
    language: "typescript",
    claimId: "claim-abc",
    bountyId: "bounty-xyz",
    agentId: "agent-007",
    baseRepoUrl: "https://github.com/org/repo.git",
    baseCommitSha: "abc123def456",
    createdAt: Date.now() - 60_000,
    readyAt: Date.now() - 30_000,
    expiresAt: Date.now() + 3_600_000,
    lastActivityAt: Date.now(),
    errorMessage: undefined,
    vmHandle: {
      vmId: "vm-flow-test",
      exec: vi.fn().mockResolvedValue({
        stdout: "",
        stderr: "",
        exitCode: 0,
      }),
      writeFile: vi.fn().mockResolvedValue(undefined),
    },
    ...overrides,
  };
}

const PROVISION_BODY = {
  workspaceId: "ws-flow-test",
  claimId: "claim-abc",
  bountyId: "bounty-xyz",
  agentId: "agent-007",
  repoUrl: "https://github.com/org/repo.git",
  commitSha: "abc123def456",
  language: "typescript",
  expiresAt: Date.now() + 4 * 60 * 60 * 1000,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isBlockedCommand).mockReturnValue(false);
  vi.mocked(validateWorkspacePath).mockImplementation(
    (p: string) => `/workspace/${p}`,
  );
});

// ===========================================================================
// FULL AGENT LIFECYCLE FLOW
// ===========================================================================

describe("Agent lifecycle flow", () => {
  it("complete flow: provision → status → exec → read → write → diff → destroy", async () => {
    const app = createTestApp();
    const session = makeReadySession();

    // ----- Step 1: Convex calls provision -----
    vi.mocked(provisionWorkspace).mockResolvedValue(session as never);

    const provisionRes = await supertest(app)
      .post("/workspace/provision")
      .set("Authorization", AUTH_HEADER)
      .send(PROVISION_BODY);

    expect(provisionRes.status).toBe(200);
    expect(provisionRes.body).toMatchObject({
      workspaceId: "ws-flow-test",
      vmId: "vm-flow-test",
      status: "ready",
      workerHost: "http://10.1.1.100:3001",
    });
    // Convex stores this workerHost in the devWorkspaces document

    // ----- Step 2: Agent polls status -----
    vi.mocked(getSession).mockReturnValue(session as never);

    const statusRes = await supertest(app)
      .post("/workspace/status")
      .set("Authorization", AUTH_HEADER)
      .send({ workspaceId: "ws-flow-test" });

    expect(statusRes.status).toBe(200);
    expect(statusRes.body).toMatchObject({
      workspaceId: "ws-flow-test",
      status: "ready",
      vmId: "vm-flow-test",
      language: "typescript",
    });
    expect(statusRes.body.createdAt).toBeDefined();
    expect(statusRes.body.readyAt).toBeDefined();
    expect(statusRes.body.expiresAt).toBeDefined();

    // ----- Step 3: Agent runs commands -----
    session.vmHandle.exec.mockResolvedValueOnce({
      stdout: "src/index.ts\nsrc/utils.ts\npackage.json\n",
      stderr: "",
      exitCode: 0,
    });

    const execRes = await supertest(app)
      .post("/workspace/exec")
      .set("Authorization", AUTH_HEADER)
      .send({ workspaceId: "ws-flow-test", command: "ls src/" });

    expect(execRes.status).toBe(200);
    expect(execRes.body.exitCode).toBe(0);
    expect(execRes.body.stdout).toContain("src/index.ts");
    // Commands run as "agent" user
    expect(session.vmHandle.exec).toHaveBeenCalledWith(
      "ls src/",
      expect.any(Number),
      "agent",
    );
    expect(touchActivity).toHaveBeenCalledWith("ws-flow-test");

    // ----- Step 4: Agent reads a file -----
    const fileContent = Buffer.from("export function hello() {\n  return 'world';\n}\n").toString("base64");
    session.vmHandle.exec.mockResolvedValueOnce({
      stdout: `{"binary":false,"totalLines":3,"content":"${fileContent}"}`,
      stderr: "",
      exitCode: 0,
    });

    const readRes = await supertest(app)
      .post("/workspace/read-file")
      .set("Authorization", AUTH_HEADER)
      .send({ workspaceId: "ws-flow-test", path: "src/index.ts" });

    expect(readRes.status).toBe(200);
    expect(readRes.body.isBinary).toBe(false);
    expect(readRes.body.content).toContain("export function hello");
    expect(readRes.body.totalLines).toBe(3);

    // ----- Step 5: Agent writes a file -----
    const writeRes = await supertest(app)
      .post("/workspace/write-file")
      .set("Authorization", AUTH_HEADER)
      .send({
        workspaceId: "ws-flow-test",
        path: "src/index.ts",
        content: "export function hello() {\n  return 'fixed world';\n}\n",
      });

    expect(writeRes.status).toBe(200);
    expect(writeRes.body.bytesWritten).toBeGreaterThan(0);
    expect(writeRes.body.path).toBe("/workspace/src/index.ts");
    expect(session.vmHandle.writeFile).toHaveBeenCalledWith(
      "/workspace/src/index.ts",
      expect.any(Buffer),
      "0644",
      "agent:agent",
    );

    // ----- Step 6: Agent extracts diff (submit_solution calls this) -----
    vi.mocked(extractDiff).mockResolvedValue({
      diffPatch: "diff --git a/src/index.ts b/src/index.ts\n--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1,3 +1,3 @@\n export function hello() {\n-  return 'world';\n+  return 'fixed world';\n }",
      diffStat: " src/index.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)",
      changedFiles: ["src/index.ts"],
      hasChanges: true,
    } as never);

    const diffRes = await supertest(app)
      .post("/workspace/diff")
      .set("Authorization", AUTH_HEADER)
      .send({ workspaceId: "ws-flow-test" });

    expect(diffRes.status).toBe(200);
    expect(diffRes.body.hasChanges).toBe(true);
    expect(diffRes.body.changedFiles).toEqual(["src/index.ts"]);
    expect(diffRes.body.diffPatch).toContain("fixed world");
    expect(diffRes.body.diffStat).toContain("1 file changed");

    // ----- Step 7: Workspace destroyed on claim release -----
    vi.mocked(destroyWorkspace).mockResolvedValue(undefined as never);

    const destroyRes = await supertest(app)
      .post("/workspace/destroy")
      .set("Authorization", AUTH_HEADER)
      .send({ workspaceId: "ws-flow-test", reason: "claim_released" });

    expect(destroyRes.status).toBe(200);
    expect(destroyRes.body.success).toBe(true);
    expect(destroyWorkspace).toHaveBeenCalledWith("ws-flow-test", "claim_released");
  });
});

// ===========================================================================
// BATCH OPERATIONS FLOW (agent reads/writes multiple files)
// ===========================================================================

describe("Batch operations flow", () => {
  it("batch-read: agent reads multiple files in one call", async () => {
    const app = createTestApp();
    const session = makeReadySession();
    vi.mocked(getSession).mockReturnValue(session as never);

    // Mock the combined exec that reads all files
    const file1 = Buffer.from("line 1\nline 2\n").toString("base64");
    const file2 = Buffer.from("import os\n").toString("base64");
    session.vmHandle.exec.mockResolvedValueOnce({
      stdout: `[{"path":"/workspace/src/a.ts","isBinary":false,"totalLines":2,"content":"${file1}"},{"path":"/workspace/src/b.py","isBinary":false,"totalLines":1,"content":"${file2}"}]`,
      stderr: "",
      exitCode: 0,
    });

    const res = await supertest(app)
      .post("/workspace/batch-read")
      .set("Authorization", AUTH_HEADER)
      .send({
        workspaceId: "ws-flow-test",
        paths: ["src/a.ts", "src/b.py"],
      });

    expect(res.status).toBe(200);
    expect(res.body.files).toHaveLength(2);
    expect(res.body.files[0].content).toContain("line 1");
    expect(res.body.files[1].content).toContain("import os");
    // Each path was validated
    expect(validateWorkspacePath).toHaveBeenCalledWith("src/a.ts");
    expect(validateWorkspacePath).toHaveBeenCalledWith("src/b.py");
    // Only 1 exec call, not 2
    expect(session.vmHandle.exec).toHaveBeenCalledTimes(1);
  });

  it("batch-read: rejects > 10 files", async () => {
    const app = createTestApp();
    const session = makeReadySession();
    vi.mocked(getSession).mockReturnValue(session as never);

    const paths = Array.from({ length: 11 }, (_, i) => `file${i}.ts`);

    const res = await supertest(app)
      .post("/workspace/batch-read")
      .set("Authorization", AUTH_HEADER)
      .send({ workspaceId: "ws-flow-test", paths });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/max 10/i);
  });

  it("batch-write: agent writes multiple files in one call", async () => {
    const app = createTestApp();
    const session = makeReadySession();
    vi.mocked(getSession).mockReturnValue(session as never);

    const res = await supertest(app)
      .post("/workspace/batch-write")
      .set("Authorization", AUTH_HEADER)
      .send({
        workspaceId: "ws-flow-test",
        files: [
          { path: "src/a.ts", content: "export const a = 1;" },
          { path: "src/b.ts", content: "export const b = 2;" },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(2);
    expect(res.body.results[0].bytesWritten).toBeGreaterThan(0);
    expect(res.body.results[1].bytesWritten).toBeGreaterThan(0);
    // Both paths validated
    expect(validateWorkspacePath).toHaveBeenCalledWith("src/a.ts");
    expect(validateWorkspacePath).toHaveBeenCalledWith("src/b.ts");
    // writeFile called for each
    expect(session.vmHandle.writeFile).toHaveBeenCalledTimes(2);
  });

  it("batch-write: rejects total content > 1MB", async () => {
    const app = createTestApp();
    const session = makeReadySession();
    vi.mocked(getSession).mockReturnValue(session as never);

    const res = await supertest(app)
      .post("/workspace/batch-write")
      .set("Authorization", AUTH_HEADER)
      .send({
        workspaceId: "ws-flow-test",
        files: [
          { path: "big.txt", content: "x".repeat(1024 * 1024 + 1) },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/too large/i);
  });
});

// ===========================================================================
// SEARCH + LIST FILES FLOW
// ===========================================================================

describe("Search and list-files flow", () => {
  it("search: finds pattern matches with structured results", async () => {
    const app = createTestApp();
    const session = makeReadySession();
    vi.mocked(getSession).mockReturnValue(session as never);

    session.vmHandle.exec.mockResolvedValueOnce({
      stdout: [
        "/workspace/src/index.ts:1:export function hello() {",
        "/workspace/src/index.ts-2-  return 'world';",
        "/workspace/src/index.ts-3-}",
        "--",
        "/workspace/src/utils.ts:5:export function helloWorld() {",
        "/workspace/src/utils.ts-6-  return hello();",
        "/workspace/src/utils.ts-7-}",
      ].join("\n"),
      stderr: "",
      exitCode: 0,
    });

    const res = await supertest(app)
      .post("/workspace/search")
      .set("Authorization", AUTH_HEADER)
      .send({
        workspaceId: "ws-flow-test",
        pattern: "hello",
        glob: "*.ts",
      });

    expect(res.status).toBe(200);
    expect(res.body.matches.length).toBeGreaterThan(0);
    // Primary matches found
    const indexMatch = res.body.matches.find(
      (m: { file: string; line: number }) => m.file === "src/index.ts" && m.line === 1,
    );
    expect(indexMatch).toBeDefined();
    expect(indexMatch.text).toContain("hello");
    expect(touchActivity).toHaveBeenCalledWith("ws-flow-test");
  });

  it("search: rejects patterns > 500 chars", async () => {
    const app = createTestApp();

    const res = await supertest(app)
      .post("/workspace/search")
      .set("Authorization", AUTH_HEADER)
      .send({
        workspaceId: "ws-flow-test",
        pattern: "a".repeat(501),
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/too long/i);
  });

  it("list-files: returns file tree with glob filter", async () => {
    const app = createTestApp();
    const session = makeReadySession();
    vi.mocked(getSession).mockReturnValue(session as never);

    session.vmHandle.exec.mockResolvedValueOnce({
      stdout: "/workspace/src/index.ts\n/workspace/src/utils.ts\n/workspace/src/types.ts\n",
      stderr: "",
      exitCode: 0,
    });

    const res = await supertest(app)
      .post("/workspace/list-files")
      .set("Authorization", AUTH_HEADER)
      .send({
        workspaceId: "ws-flow-test",
        glob: "*.ts",
        maxDepth: 5,
      });

    expect(res.status).toBe(200);
    expect(res.body.files).toContain("src/index.ts");
    expect(res.body.files).toContain("src/utils.ts");
    expect(res.body.truncated).toBe(false);
  });
});

// ===========================================================================
// STREAMING EXEC FLOW (long-running commands)
// ===========================================================================

describe("Streaming exec flow", () => {
  it("start + poll: agent runs long command and polls for output", async () => {
    const app = createTestApp();
    const session = makeReadySession();
    vi.mocked(getSession).mockReturnValue(session as never);

    // exec-stream: start the command (returns PID)
    session.vmHandle.exec.mockResolvedValueOnce({
      stdout: "12345\n",
      stderr: "",
      exitCode: 0,
    });

    const startRes = await supertest(app)
      .post("/workspace/exec-stream")
      .set("Authorization", AUTH_HEADER)
      .send({
        workspaceId: "ws-flow-test",
        command: "npm test",
      });

    expect(startRes.status).toBe(200);
    expect(startRes.body.jobId).toBeDefined();
    const jobId = startRes.body.jobId;

    // exec-output: poll for partial output (command still running)
    session.vmHandle.exec
      .mockResolvedValueOnce({ stdout: "PASS src/a.test.ts\n", stderr: "", exitCode: 0 })  // stdout
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 })                       // stderr
      .mockResolvedValueOnce({ stdout: "RUNNING\n", stderr: "", exitCode: 0 });             // rc check

    const poll1 = await supertest(app)
      .post("/workspace/exec-output")
      .set("Authorization", AUTH_HEADER)
      .send({ workspaceId: "ws-flow-test", jobId, offset: 0 });

    expect(poll1.status).toBe(200);
    expect(poll1.body.done).toBe(false);
    expect(poll1.body.stdout).toContain("PASS");
    expect(poll1.body.offset).toBeGreaterThan(0);

    // exec-output: poll again, command is done
    session.vmHandle.exec
      .mockResolvedValueOnce({ stdout: "PASS src/b.test.ts\n", stderr: "", exitCode: 0 })  // stdout
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 })                       // stderr
      .mockResolvedValueOnce({ stdout: "0\n", stderr: "", exitCode: 0 });                   // rc = 0

    const poll2 = await supertest(app)
      .post("/workspace/exec-output")
      .set("Authorization", AUTH_HEADER)
      .send({ workspaceId: "ws-flow-test", jobId, offset: poll1.body.offset });

    expect(poll2.status).toBe(200);
    expect(poll2.body.done).toBe(true);
    expect(poll2.body.exitCode).toBe(0);
    expect(poll2.body.stdout).toContain("PASS src/b.test.ts");
  });

  it("rejects blocked commands in exec-stream", async () => {
    const app = createTestApp();
    vi.mocked(isBlockedCommand).mockReturnValue(true);

    const res = await supertest(app)
      .post("/workspace/exec-stream")
      .set("Authorization", AUTH_HEADER)
      .send({ workspaceId: "ws-flow-test", command: "poweroff" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not allowed/i);
  });

  it("enforces max 3 concurrent streaming jobs per workspace", async () => {
    const app = createTestApp();
    const session = makeReadySession();
    vi.mocked(getSession).mockReturnValue(session as never);

    // Start 3 jobs successfully
    for (let i = 0; i < 3; i++) {
      session.vmHandle.exec.mockResolvedValueOnce({
        stdout: `${1000 + i}\n`,
        stderr: "",
        exitCode: 0,
      });

      const res = await supertest(app)
        .post("/workspace/exec-stream")
        .set("Authorization", AUTH_HEADER)
        .send({ workspaceId: "ws-flow-test", command: `sleep ${i}` });

      expect(res.status).toBe(200);
    }

    // 4th job should be rejected
    const res = await supertest(app)
      .post("/workspace/exec-stream")
      .set("Authorization", AUTH_HEADER)
      .send({ workspaceId: "ws-flow-test", command: "echo overflow" });

    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/concurrent/i);
  });

  it("returns 404 for non-existent job ID", async () => {
    const app = createTestApp();
    const session = makeReadySession();
    vi.mocked(getSession).mockReturnValue(session as never);

    const res = await supertest(app)
      .post("/workspace/exec-output")
      .set("Authorization", AUTH_HEADER)
      .send({ workspaceId: "ws-flow-test", jobId: "nonexistent-job-id" });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });
});

// ===========================================================================
// PROVISION → RESPONSE FIELDS (what Convex needs to store)
// ===========================================================================

describe("Provision response contract", () => {
  it("returns workerHost from WORKER_HOST_URL env var", async () => {
    const app = createTestApp();
    const session = makeReadySession();
    vi.mocked(provisionWorkspace).mockResolvedValue(session as never);

    const res = await supertest(app)
      .post("/workspace/provision")
      .set("Authorization", AUTH_HEADER)
      .send(PROVISION_BODY);

    // Convex stores workerHost and uses it for MCP → Worker direct calls
    expect(res.body.workerHost).toBe("http://10.1.1.100:3001");
  });

  it("returns workerHost localhost fallback when WORKER_HOST_URL not set", async () => {
    const originalUrl = process.env.WORKER_HOST_URL;
    delete process.env.WORKER_HOST_URL;

    const app = createTestApp();
    const session = makeReadySession();
    vi.mocked(provisionWorkspace).mockResolvedValue(session as never);

    const res = await supertest(app)
      .post("/workspace/provision")
      .set("Authorization", AUTH_HEADER)
      .send(PROVISION_BODY);

    expect(res.body.workerHost).toBe("http://localhost:3001");
    process.env.WORKER_HOST_URL = originalUrl;
  });

  it("includes all fields Convex devWorkspaces.updateStatus expects", async () => {
    const app = createTestApp();
    const session = makeReadySession();
    vi.mocked(provisionWorkspace).mockResolvedValue(session as never);

    const res = await supertest(app)
      .post("/workspace/provision")
      .set("Authorization", AUTH_HEADER)
      .send(PROVISION_BODY);

    // These fields are read by convex/devWorkspaces.ts provisionWorkspace action
    expect(res.body).toHaveProperty("workspaceId");
    expect(res.body).toHaveProperty("vmId");
    expect(res.body).toHaveProperty("status");
    expect(res.body).toHaveProperty("workerHost");
    expect(typeof res.body.workspaceId).toBe("string");
    expect(typeof res.body.vmId).toBe("string");
    expect(typeof res.body.status).toBe("string");
    expect(typeof res.body.workerHost).toBe("string");
  });

  it("returns 503 with retryAfterMs on capacity error", async () => {
    const err = new Error("Worker at capacity. Please try again later.");
    (err as { retryAfterMs: number }).retryAfterMs = 120_000;
    vi.mocked(provisionWorkspace).mockRejectedValue(err);

    const app = createTestApp();
    const res = await supertest(app)
      .post("/workspace/provision")
      .set("Authorization", AUTH_HEADER)
      .send(PROVISION_BODY);

    expect(res.status).toBe(503);
    expect(res.body.retryAfterMs).toBe(120_000);
    expect(res.body.error).toContain("capacity");
  });
});

// ===========================================================================
// STATUS RESPONSE CONTRACT (what MCP workspace_status tool expects)
// ===========================================================================

describe("Status response contract", () => {
  it("returns all fields the MCP workspace_status tool expects", async () => {
    const app = createTestApp();
    const session = makeReadySession();
    vi.mocked(getSession).mockReturnValue(session as never);

    const res = await supertest(app)
      .post("/workspace/status")
      .set("Authorization", AUTH_HEADER)
      .send({ workspaceId: "ws-flow-test" });

    expect(res.body).toHaveProperty("workspaceId");
    expect(res.body).toHaveProperty("status");
    expect(res.body).toHaveProperty("vmId");
    expect(res.body).toHaveProperty("language");
    expect(res.body).toHaveProperty("createdAt");
    expect(res.body).toHaveProperty("readyAt");
    expect(res.body).toHaveProperty("expiresAt");
    expect(res.body).toHaveProperty("lastActivityAt");
    // errorMessage is undefined for ready workspaces
    expect(res.body.errorMessage).toBeUndefined();
  });

  it("includes errorMessage for error workspaces", async () => {
    const app = createTestApp();
    const session = makeReadySession({
      status: "error",
      errorMessage: "VM boot failed: out of memory",
    });
    vi.mocked(getSession).mockReturnValue(session as never);

    const res = await supertest(app)
      .post("/workspace/status")
      .set("Authorization", AUTH_HEADER)
      .send({ workspaceId: "ws-flow-test" });

    expect(res.body.status).toBe("error");
    expect(res.body.errorMessage).toBe("VM boot failed: out of memory");
  });
});

// ===========================================================================
// DIFF RESPONSE CONTRACT (what MCP submit_solution expects)
// ===========================================================================

describe("Diff response contract", () => {
  it("returns all fields submit_solution expects", async () => {
    const app = createTestApp();
    const session = makeReadySession();
    vi.mocked(getSession).mockReturnValue(session as never);

    vi.mocked(extractDiff).mockResolvedValue({
      diffPatch: "diff --git a/f.ts b/f.ts\n-old\n+new",
      diffStat: " 1 file changed",
      changedFiles: ["f.ts"],
      hasChanges: true,
    } as never);

    const res = await supertest(app)
      .post("/workspace/diff")
      .set("Authorization", AUTH_HEADER)
      .send({ workspaceId: "ws-flow-test" });

    // These fields are read by mcp-server/src/tools/submitSolution.ts
    expect(res.body).toHaveProperty("diffPatch");
    expect(res.body).toHaveProperty("diffStat");
    expect(res.body).toHaveProperty("changedFiles");
    expect(res.body).toHaveProperty("hasChanges");
    expect(typeof res.body.diffPatch).toBe("string");
    expect(typeof res.body.diffStat).toBe("string");
    expect(Array.isArray(res.body.changedFiles)).toBe(true);
    expect(typeof res.body.hasChanges).toBe("boolean");
  });

  it("returns hasChanges=false when no changes", async () => {
    const app = createTestApp();
    const session = makeReadySession();
    vi.mocked(getSession).mockReturnValue(session as never);

    vi.mocked(extractDiff).mockResolvedValue({
      diffPatch: "",
      diffStat: "",
      changedFiles: [],
      hasChanges: false,
    } as never);

    const res = await supertest(app)
      .post("/workspace/diff")
      .set("Authorization", AUTH_HEADER)
      .send({ workspaceId: "ws-flow-test" });

    expect(res.body.hasChanges).toBe(false);
    expect(res.body.changedFiles).toEqual([]);
  });
});

// ===========================================================================
// EXEC RESPONSE CONTRACT (what MCP workspace_exec expects)
// ===========================================================================

describe("Exec response contract", () => {
  it("returns stdout, stderr, exitCode", async () => {
    const app = createTestApp();
    const session = makeReadySession();
    vi.mocked(getSession).mockReturnValue(session as never);

    session.vmHandle.exec.mockResolvedValueOnce({
      stdout: "Tests: 5 passed\n",
      stderr: "warning: unused import\n",
      exitCode: 0,
    });

    const res = await supertest(app)
      .post("/workspace/exec")
      .set("Authorization", AUTH_HEADER)
      .send({ workspaceId: "ws-flow-test", command: "npm test" });

    // These fields are read by mcp-server/src/tools/workspaceExec.ts
    expect(res.body).toHaveProperty("stdout");
    expect(res.body).toHaveProperty("stderr");
    expect(res.body).toHaveProperty("exitCode");
    expect(res.body.stdout).toContain("5 passed");
    expect(res.body.stderr).toContain("warning");
    expect(res.body.exitCode).toBe(0);
  });

  it("returns non-zero exitCode on command failure", async () => {
    const app = createTestApp();
    const session = makeReadySession();
    vi.mocked(getSession).mockReturnValue(session as never);

    session.vmHandle.exec.mockResolvedValueOnce({
      stdout: "",
      stderr: "Error: Cannot find module './missing'\n",
      exitCode: 1,
    });

    const res = await supertest(app)
      .post("/workspace/exec")
      .set("Authorization", AUTH_HEADER)
      .send({ workspaceId: "ws-flow-test", command: "node missing.js" });

    expect(res.status).toBe(200); // HTTP 200 even on command failure
    expect(res.body.exitCode).toBe(1);
    expect(res.body.stderr).toContain("Cannot find module");
  });
});

// ===========================================================================
// READ-FILE RESPONSE CONTRACT (what MCP workspace_read_file expects)
// ===========================================================================

describe("Read-file response contract", () => {
  it("returns content, path, totalLines, isBinary for text files", async () => {
    const app = createTestApp();
    const session = makeReadySession();
    vi.mocked(getSession).mockReturnValue(session as never);

    const content = Buffer.from("const x = 1;\n").toString("base64");
    session.vmHandle.exec.mockResolvedValueOnce({
      stdout: `{"binary":false,"totalLines":1,"content":"${content}"}`,
      stderr: "",
      exitCode: 0,
    });

    const res = await supertest(app)
      .post("/workspace/read-file")
      .set("Authorization", AUTH_HEADER)
      .send({ workspaceId: "ws-flow-test", path: "src/x.ts" });

    // These fields are read by mcp-server/src/tools/workspaceReadFile.ts
    expect(res.body).toHaveProperty("content");
    expect(res.body).toHaveProperty("path");
    expect(res.body).toHaveProperty("totalLines");
    expect(res.body).toHaveProperty("isBinary");
    expect(res.body.isBinary).toBe(false);
    expect(res.body.content).toBe("const x = 1;\n");
  });

  it("handles file not found", async () => {
    const app = createTestApp();
    const session = makeReadySession();
    vi.mocked(getSession).mockReturnValue(session as never);

    session.vmHandle.exec.mockResolvedValueOnce({
      stdout: '{"error":"not_found"}',
      stderr: "",
      exitCode: 0,
    });

    const res = await supertest(app)
      .post("/workspace/read-file")
      .set("Authorization", AUTH_HEADER)
      .send({ workspaceId: "ws-flow-test", path: "nonexistent.ts" });

    expect(res.status).toBe(200); // Not a 404 — the file doesn't exist in the workspace
    expect(res.body.content).toContain("not found");
  });
});

// ===========================================================================
// WRITE-FILE RESPONSE CONTRACT (what MCP workspace_write_file expects)
// ===========================================================================

describe("Write-file response contract", () => {
  it("returns bytesWritten and path", async () => {
    const app = createTestApp();
    const session = makeReadySession();
    vi.mocked(getSession).mockReturnValue(session as never);

    const res = await supertest(app)
      .post("/workspace/write-file")
      .set("Authorization", AUTH_HEADER)
      .send({
        workspaceId: "ws-flow-test",
        path: "src/new.ts",
        content: "export const y = 2;",
      });

    // These fields are read by mcp-server/src/tools/workspaceWriteFile.ts
    expect(res.body).toHaveProperty("bytesWritten");
    expect(res.body).toHaveProperty("path");
    expect(res.body.bytesWritten).toBe(Buffer.byteLength("export const y = 2;"));
    expect(res.body.path).toBe("/workspace/src/new.ts");
  });
});

// ===========================================================================
// EXTEND-TTL FLOW (agent extends claim)
// ===========================================================================

describe("Extend-TTL flow", () => {
  it("extends workspace TTL when agent extends claim", async () => {
    const app = createTestApp();
    const newExpiry = Date.now() + 8 * 60 * 60 * 1000;

    vi.mocked(extendTTL).mockReturnValue(undefined as never);

    const res = await supertest(app)
      .post("/workspace/extend-ttl")
      .set("Authorization", AUTH_HEADER)
      .send({
        workspaceId: "ws-flow-test",
        newExpiresAt: newExpiry,
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.expiresAt).toBe(newExpiry);
    expect(extendTTL).toHaveBeenCalledWith("ws-flow-test", newExpiry);
  });
});

// ===========================================================================
// ERROR SCENARIOS AN AGENT ENCOUNTERS
// ===========================================================================

describe("Agent error scenarios", () => {
  it("workspace not found returns 404 for all operations", async () => {
    const app = createTestApp();
    vi.mocked(getSession).mockReturnValue(undefined as never);

    const endpoints = [
      { path: "/workspace/exec", body: { workspaceId: "ws-gone", command: "ls" } },
      { path: "/workspace/read-file", body: { workspaceId: "ws-gone", path: "f.ts" } },
      { path: "/workspace/write-file", body: { workspaceId: "ws-gone", path: "f.ts", content: "x" } },
      { path: "/workspace/diff", body: { workspaceId: "ws-gone" } },
      { path: "/workspace/batch-read", body: { workspaceId: "ws-gone", paths: ["f.ts"] } },
      { path: "/workspace/batch-write", body: { workspaceId: "ws-gone", files: [{ path: "f.ts", content: "x" }] } },
      { path: "/workspace/search", body: { workspaceId: "ws-gone", pattern: "x" } },
      { path: "/workspace/list-files", body: { workspaceId: "ws-gone" } },
      { path: "/workspace/exec-stream", body: { workspaceId: "ws-gone", command: "ls" } },
    ];

    for (const ep of endpoints) {
      const res = await supertest(app)
        .post(ep.path)
        .set("Authorization", AUTH_HEADER)
        .send(ep.body);

      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/not found/i);
    }
  });

  it("workspace in error state returns 404 for workspace ops", async () => {
    const app = createTestApp();
    const session = makeReadySession({ status: "error" });
    vi.mocked(getSession).mockReturnValue(session as never);

    const res = await supertest(app)
      .post("/workspace/exec")
      .set("Authorization", AUTH_HEADER)
      .send({ workspaceId: "ws-flow-test", command: "ls" });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not ready/i);
  });

  it("destroyed workspace returns 404", async () => {
    const app = createTestApp();
    const session = makeReadySession({ status: "destroyed" });
    vi.mocked(getSession).mockReturnValue(session as never);

    const res = await supertest(app)
      .post("/workspace/exec")
      .set("Authorization", AUTH_HEADER)
      .send({ workspaceId: "ws-flow-test", command: "ls" });

    expect(res.status).toBe(404);
  });

  it("unauthenticated requests rejected on all endpoints", async () => {
    const app = createTestApp();

    const endpoints = [
      "/workspace/provision",
      "/workspace/exec",
      "/workspace/read-file",
      "/workspace/write-file",
      "/workspace/diff",
      "/workspace/status",
      "/workspace/destroy",
      "/workspace/batch-read",
      "/workspace/batch-write",
      "/workspace/search",
      "/workspace/list-files",
      "/workspace/exec-stream",
      "/workspace/exec-output",
      "/workspace/extend-ttl",
    ];

    for (const path of endpoints) {
      const res = await supertest(app)
        .post(path)
        .send({ workspaceId: "ws-1" });

      expect(res.status).toBe(401);
    }
  });
});
