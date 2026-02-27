import express from "express";
import { createServer, Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../../worker/src/index", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../../../worker/src/workspace/sessionStore", () => ({
  sessionStore: {
    ping: vi.fn(async () => "PONG"),
    save: vi.fn(async () => undefined),
    updateStatus: vi.fn(async () => undefined),
    updateActivity: vi.fn(async () => undefined),
    updateHeartbeat: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  },
}));

vi.mock("../../../worker/src/workspace/heartbeat", () => ({
  workspaceHeartbeat: {
    startMonitoring: vi.fn(),
    stopMonitoring: vi.fn(),
    startWorkerHeartbeat: vi.fn(),
    stopAll: vi.fn(),
  },
}));

vi.mock("../../../worker/src/lib/shellSanitize", () => ({
  sanitizeShellArg: (value: string) => `'${value.replace(/'/g, "'\\''")}'`,
}));

import { registerClaimBounty } from "./claimBounty";
import { registerWorkspaceExec } from "./workspaceExec";
import { registerWorkspaceWriteFile } from "./workspaceWriteFile";
import { registerWorkspaceReadFile } from "./workspaceReadFile";
import { registerReleaseClaim } from "./releaseClaim";
import { runWithAuth } from "../lib/context";
import { initConvexClient } from "../convex/client";
import { initWorkerClient, callWorker } from "../worker/client";
import { invalidateWorkspaceCache } from "../workspace/cache";
import type { AuthenticatedUser } from "../lib/types";

const execFileAsync = promisify(execFile);

type ToolHandler = (args: Record<string, string>) => Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}>;

function createMockServer() {
  const handlers = new Map<string, ToolHandler>();
  return {
    tool: (
      name: string,
      _description: string,
      _schema: unknown,
      handler: ToolHandler,
    ) => handlers.set(name, handler),
    getHandler(name: string): ToolHandler {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`Missing tool handler: ${name}`);
      return handler;
    },
  };
}

async function startHttpServer(app: express.Express): Promise<{ server: Server; url: string }> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to bind HTTP server");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

describe("integration: MCP -> worker -> execution env chain", () => {
  let workerServer: Server;
  let convexServer: Server;
  let workerBaseUrl = "";
  let convexBaseUrl = "";
  let gitRepoDir = "";
  let commitSha = "";
  let claimId = "";
  let workspaceId = "";
  let workerHost = "";

  const workerSecret = "worker-secret-integration";
  const convexSecret = "convex-secret-integration";
  const bountyId = "bounty-integration-1";
  const testUser: AuthenticatedUser = {
    userId: "user-integration-1",
    name: "Integration Agent",
    email: "integration@agent.dev",
    role: "agent",
    scopes: [
      "bounties:read",
      "bounties:claim",
      "workspace:exec",
      "workspace:read",
      "workspace:write",
    ],
  };

  beforeAll(async () => {
    process.env.WORKER_SHARED_SECRET = workerSecret;
    process.env.WORKER_EXECUTION_BACKEND = "process";
    process.env.ALLOW_UNSAFE_PROCESS_BACKEND = "true";
    process.env.REDIS_URL = "redis://127.0.0.1:6390";

    const { createWorkspaceRoutes } = await import("../../../worker/src/workspace/routes");
    const { destroyAllSessions } = await import("../../../worker/src/workspace/sessionManager");

    const workerApp = express();
    workerApp.use(express.json({ limit: "12mb" }));
    workerApp.use("/api", (req, res, next) => {
      const token = req.header("authorization");
      if (token !== `Bearer ${workerSecret}`) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      next();
    });
    workerApp.use("/api", createWorkspaceRoutes());

    const workerStarted = await startHttpServer(workerApp);
    workerServer = workerStarted.server;
    workerBaseUrl = workerStarted.url;
    process.env.WORKER_HOST_URL = workerBaseUrl;

    const workspaceByAgentAndBounty = new Map<
      string,
      { claimId: string; workspaceId: string; workerHost: string; status: "ready" | "destroyed" }
    >();

    const convexApp = express();
    convexApp.use(express.json());
    convexApp.use((req, res, next) => {
      if (req.header("authorization") !== `Bearer ${convexSecret}`) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      next();
    });

    convexApp.post("/api/mcp/bounties/get", (_req, res) => {
      res.json({
        bounty: {
          _id: bountyId,
          title: "Integration Test Bounty",
          description: "Validates MCP-worker-execution flow",
          status: "active",
          reward: 1,
          rewardCurrency: "USD",
          claimDurationHours: 4,
          creator: null,
          testSuites: [],
          repoMap: null,
          isClaimed: false,
        },
      });
    });

    convexApp.post("/api/mcp/claims/create", async (req, res) => {
      const { agentId, bountyId: reqBountyId } = req.body as { agentId: string; bountyId: string };
      claimId = `claim-${Date.now()}`;
      workspaceId = `ws-${Date.now()}`;

      const provisionResp = await fetch(`${workerBaseUrl}/api/workspace/provision`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${workerSecret}`,
        },
        body: JSON.stringify({
          workspaceId,
          claimId,
          bountyId: reqBountyId,
          agentId,
          repoUrl: gitRepoDir,
          commitSha,
          language: "typescript",
          expiresAt: Date.now() + 30 * 60 * 1000,
        }),
      });

      if (!provisionResp.ok) {
        const errorBody = await provisionResp.text();
        res.status(500).json({ error: `Provision failed: ${errorBody}` });
        return;
      }

      const provisioned = await provisionResp.json() as { workerHost: string };
      workerHost = provisioned.workerHost;
      workspaceByAgentAndBounty.set(`${agentId}:${reqBountyId}`, {
        claimId,
        workspaceId,
        workerHost,
        status: "ready",
      });

      res.json({ claimId, repoInfo: null });
    });

    convexApp.post("/api/mcp/workspace/lookup", (req, res) => {
      const { agentId, bountyId: reqBountyId } = req.body as { agentId: string; bountyId: string };
      const record = workspaceByAgentAndBounty.get(`${agentId}:${reqBountyId}`);
      if (!record || record.status !== "ready") {
        res.json({
          found: false,
          workspaceId: "",
          workerHost: "",
          status: "destroyed",
          expiresAt: 0,
        });
        return;
      }

      res.json({
        found: true,
        workspaceId: record.workspaceId,
        workerHost: record.workerHost,
        status: "ready",
        expiresAt: Date.now() + 30 * 60 * 1000,
      });
    });

    convexApp.post("/api/mcp/claims/release", async (req, res) => {
      const { claimId: releaseClaimId, agentId } = req.body as { claimId: string; agentId: string };
      const key = `${agentId}:${bountyId}`;
      const record = workspaceByAgentAndBounty.get(key);

      if (!record || record.claimId !== releaseClaimId) {
        res.status(404).json({ error: "Claim not found" });
        return;
      }

      await fetch(`${record.workerHost}/api/workspace/destroy`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${workerSecret}`,
        },
        body: JSON.stringify({
          workspaceId: record.workspaceId,
          reason: "released",
        }),
      });

      workspaceByAgentAndBounty.set(key, { ...record, status: "destroyed" });
      res.json({ success: true });
    });

    const convexStarted = await startHttpServer(convexApp);
    convexServer = convexStarted.server;
    convexBaseUrl = convexStarted.url;

    const repoBase = await mkdtemp(join(tmpdir(), "arcagent-integration-repo-"));
    gitRepoDir = repoBase;
    await writeFile(join(gitRepoDir, "README.md"), "# integration\n", "utf-8");
    await execFileAsync("git", ["init"], { cwd: gitRepoDir });
    await execFileAsync("git", ["config", "user.email", "integration@test.dev"], { cwd: gitRepoDir });
    await execFileAsync("git", ["config", "user.name", "Integration Test"], { cwd: gitRepoDir });
    await execFileAsync("git", ["add", "."], { cwd: gitRepoDir });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd: gitRepoDir });
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: gitRepoDir });
    commitSha = stdout.trim();

    initConvexClient(convexBaseUrl, convexSecret);
    initWorkerClient(workerSecret);

    (globalThis as unknown as { __destroyAllSessions?: () => Promise<void> }).__destroyAllSessions =
      destroyAllSessions;
  });

  afterAll(async () => {
    const destroyAllSessions =
      (globalThis as unknown as { __destroyAllSessions?: () => Promise<void> }).__destroyAllSessions;
    if (destroyAllSessions) {
      await destroyAllSessions();
    }

    if (workerServer) {
      await new Promise<void>((resolve, reject) =>
        workerServer.close((err) => (err ? reject(err) : resolve())),
      );
    }
    if (convexServer) {
      await new Promise<void>((resolve, reject) =>
        convexServer.close((err) => (err ? reject(err) : resolve())),
      );
    }
    if (gitRepoDir) {
      await rm(gitRepoDir, { recursive: true, force: true });
    }
    delete process.env.ALLOW_UNSAFE_PROCESS_BACKEND;
  });

  it("provisions workspace, executes commands/files through MCP, then tears down cleanly", async () => {
    const server = createMockServer();
    registerClaimBounty(server as never);
    registerWorkspaceExec(server as never);
    registerWorkspaceWriteFile(server as never);
    registerWorkspaceReadFile(server as never);
    registerReleaseClaim(server as never);

    const claimHandler = server.getHandler("claim_bounty");
    const execHandler = server.getHandler("workspace_exec");
    const writeHandler = server.getHandler("workspace_write_file");
    const readHandler = server.getHandler("workspace_read_file");
    const releaseHandler = server.getHandler("release_claim");

    const claimResult = await runWithAuth(testUser, () => claimHandler({ bountyId }));
    expect(claimResult.isError).toBeUndefined();
    expect(claimResult.content[0].text).toContain("Bounty Claimed Successfully");
    expect(workspaceId).toBeTruthy();
    expect(claimId).toBeTruthy();

    const execResult = await runWithAuth(testUser, () =>
      execHandler({ bountyId, command: "git rev-parse --short HEAD" }),
    );
    expect(execResult.isError).toBeUndefined();
    expect(execResult.content[0].text).toContain(commitSha.slice(0, 7));

    const writeResult = await runWithAuth(testUser, () =>
      writeHandler({
        bountyId,
        path: "notes.txt",
        content: "mcp-worker-execution-integration",
      }),
    );
    expect(writeResult.isError).toBeUndefined();
    expect(writeResult.content[0].text).toContain("Written");

    const readResult = await runWithAuth(testUser, () =>
      readHandler({ bountyId, path: "notes.txt" }),
    );
    expect(readResult.isError).toBeUndefined();
    expect(readResult.content[0].text).toContain("mcp-worker-execution-integration");

    const releaseResult = await runWithAuth(testUser, () =>
      releaseHandler({ claimId }),
    );
    expect(releaseResult.isError).toBeUndefined();
    expect(releaseResult.content[0].text).toContain("Claim released successfully");

    invalidateWorkspaceCache(testUser.userId, bountyId);

    const postReleaseResult = await runWithAuth(testUser, () =>
      execHandler({ bountyId, command: "pwd" }),
    );
    expect(postReleaseResult.isError).toBe(true);
    expect(postReleaseResult.content[0].text).toContain("No workspace found");

    await expect(
      callWorker(workerHost, "/api/workspace/exec", {
        workspaceId,
        command: "pwd",
      }),
    ).rejects.toThrow(/Workspace not found or not ready/);
  });
});
