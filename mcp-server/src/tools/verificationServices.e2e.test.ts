import express from "express";
import { createServer, Server } from "node:http";
import { mkdtemp, rm, writeFile, chmod, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { initConvexClient } from "../convex/client";
import { runWithAuth } from "../lib/context";
import { registerGetVerificationStatus } from "./getVerificationStatus";
import type { AuthenticatedUser } from "../lib/types";

vi.mock("../../../worker/src/index", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../../../worker/src/lib/shellSanitize", () => ({
  sanitizeShellArg: (value: string) => `'${value.replace(/'/g, "'\\''")}'`,
  validateShellArg: (value: string) => value,
  sanitizeFilePath: (value: string) => `'${value.replace(/'/g, "'\\''")}'`,
}));

const execFileAsync = promisify(execFile);

function createMockServer() {
  const handlers = new Map<string, (args: Record<string, string>) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
  }>>();

  return {
    tool: (
      name: string,
      _description: string,
      _schema: unknown,
      handler: (args: Record<string, string>) => Promise<{
        content: Array<{ type: "text"; text: string }>;
        isError?: boolean;
      }>,
    ) => handlers.set(name, handler),
    getHandler(name: string) {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`Missing tool handler: ${name}`);
      return handler;
    },
  };
}

async function startHttpServer(app: express.Express): Promise<{ server: Server; url: string }> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("Failed to bind server");
  return { server, url: `http://127.0.0.1:${addr.port}` };
}

describe("e2e: redis + sonar/snyk gates + mcp result relay", () => {
  let redisContainerName = "";
  const redisPort = 16379;
  let workerServer: Server;
  let convexServer: Server;
  let sonarServer: Server;
  let workerBaseUrl = "";
  let convexBaseUrl = "";
  let sonarBaseUrl = "";
  let gitRepoDir = "";
  let binDir = "";
  let tempRoot = "";
  const originalPath = process.env.PATH ?? "";
  const originalProcessBackendPath = process.env.PROCESS_BACKEND_PATH ?? "";
  let queue: Awaited<ReturnType<typeof import("../../../worker/src/queue/jobQueue").createVerificationQueue>>["queue"];
  let worker: Awaited<ReturnType<typeof import("../../../worker/src/queue/jobQueue").createVerificationQueue>>["worker"];
  let queueEvents: Awaited<ReturnType<typeof import("../../../worker/src/queue/jobQueue").createVerificationQueue>>["queueEvents"];

  const workerSecret = "worker-secret-e2e";
  const convexSecret = "convex-secret-e2e";
  const submissionId = "submission-e2e-1";
  const bountyId = "bounty-e2e-1";
  const testUser: AuthenticatedUser = {
    userId: "user-e2e-1",
    name: "E2E Agent",
    email: "e2e@agent.dev",
    role: "agent",
    scopes: ["bounties:read"],
  };

  const verificationState: {
    latestPayload: any | null;
    resolvePayload?: (value: any) => void;
  } = {
    latestPayload: null,
  };

  beforeAll(async () => {
    redisContainerName = `arcagent-e2e-redis-${Date.now()}`;

    // 1) Spin up Redis container and wait until reachable.
    await execFileAsync("docker", [
      "run",
      "-d",
      "--rm",
      "--name",
      redisContainerName,
      "-p",
      `${redisPort}:6379`,
      "redis:7-alpine",
    ]);

    let redisReady = false;
    for (let i = 0; i < 30; i++) {
      try {
        const { stdout } = await execFileAsync("docker", ["exec", redisContainerName, "redis-cli", "ping"]);
        if (stdout.trim() === "PONG") {
          redisReady = true;
          break;
        }
      } catch {
        // retry
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!redisReady) {
      throw new Error("Redis did not become ready for e2e test");
    }

    // 2) Spin up SonarQube-compatible mock service.
    const sonarApp = express();
    sonarApp.get("/api/qualitygates/project_status", (_req, res) => {
      res.json({
        projectStatus: {
          status: "OK",
          conditions: [],
        },
      });
    });
    const sonarStarted = await startHttpServer(sonarApp);
    sonarServer = sonarStarted.server;
    sonarBaseUrl = sonarStarted.url;

    // 3) Mock snyk + sonar-scanner CLIs for process backend execution.
    tempRoot = await mkdtemp(join(tmpdir(), "arcagent-e2e-stack-"));
    binDir = join(tempRoot, "bin");
    await mkdir(binDir, { recursive: true });

    const snykScript = `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"code test"* ]]; then
  cat <<'JSON'
{"runs":[{"results":[]}]}
JSON
  exit 0
fi
cat <<'JSON'
{"vulnerabilities":[]}
JSON
exit 0
`;

    const sonarScannerScript = `#!/usr/bin/env bash
set -euo pipefail
# Simulate successful scanner run
exit 0
`;

    await writeFile(join(binDir, "snyk"), snykScript, "utf-8");
    await writeFile(join(binDir, "sonar-scanner"), sonarScannerScript, "utf-8");
    await chmod(join(binDir, "snyk"), 0o755);
    await chmod(join(binDir, "sonar-scanner"), 0o755);

    process.env.PATH = `${binDir}:${originalPath}`;
    process.env.PROCESS_BACKEND_PATH = `${binDir}:${originalPath}`;

    // 4) Create a git repo the worker can clone.
    gitRepoDir = await mkdtemp(join(tmpdir(), "arcagent-e2e-repo-"));
    await writeFile(
      join(gitRepoDir, "package.json"),
      JSON.stringify(
        {
          name: "arcagent-e2e-repo",
          version: "1.0.0",
          private: true,
          scripts: {
            test: "echo e2e-test-ok",
          },
          devDependencies: {
            typescript: "^5.0.0",
            eslint: "^9.0.0",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    await writeFile(
      join(gitRepoDir, "eslint.config.mjs"),
      "export default [];\n",
      "utf-8",
    );
    await writeFile(
      join(gitRepoDir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { target: "ES2020" }, include: ["src/**/*.ts"] }, null, 2),
      "utf-8",
    );
    await mkdir(join(gitRepoDir, "src"), { recursive: true });
    await writeFile(join(gitRepoDir, "src", "index.ts"), "export const x = 1;\n", "utf-8");

    await execFileAsync("npm", ["install", "--package-lock-only"], { cwd: gitRepoDir });
    await execFileAsync("git", ["init"], { cwd: gitRepoDir });
    await execFileAsync("git", ["config", "user.email", "e2e@test.dev"], { cwd: gitRepoDir });
    await execFileAsync("git", ["config", "user.name", "E2E Test"], { cwd: gitRepoDir });
    await execFileAsync("git", ["add", "."], { cwd: gitRepoDir });
    await execFileAsync("git", ["commit", "-m", "init"], { cwd: gitRepoDir });

    const { stdout: commitOut } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: gitRepoDir });
    const commitSha = commitOut.trim();

    // 5) Fake Convex endpoints: capture worker callback and expose MCP status endpoint.
    const convexApp = express();
    convexApp.use(express.json({ limit: "12mb" }));
    convexApp.use((req, res, next) => {
      if (req.header("authorization") !== `Bearer ${convexSecret}` && req.path.startsWith("/api/mcp")) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      next();
    });

    convexApp.post("/api/verification/result", (req, res) => {
      if (req.header("authorization") !== `Bearer ${workerSecret}`) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      verificationState.latestPayload = req.body;
      if (verificationState.resolvePayload) {
        verificationState.resolvePayload(req.body);
        verificationState.resolvePayload = undefined;
      }
      res.json({ success: true });
    });

    convexApp.post("/api/mcp/verifications/get", (_req, res) => {
      if (!verificationState.latestPayload) {
        res.status(404).json({ error: "Verification not found" });
        return;
      }

      const payload = verificationState.latestPayload;
      const verificationStatus = payload.overallStatus === "pass" ? "passed" : payload.overallStatus === "error" ? "error" : "failed";

      const gates = (payload.gates ?? []).map((g: any) => ({
        gateType: g.gate,
        tool: g.summary ?? g.gate,
        status: g.status === "pass" ? "passed" : g.status === "fail" ? "failed" : "warning",
        issues: g.summary ? [g.summary] : [],
        details: g.details,
      }));

      res.json({
        verification: {
          _id: "verification-e2e-1",
          submissionId: payload.submissionId,
          bountyId: payload.bountyId,
          status: verificationStatus,
          gates,
          steps: payload.steps ?? [],
          feedbackJson: payload.feedbackJson ?? null,
          job: {
            status: verificationStatus,
            queuedAt: Date.now() - 2000,
            completedAt: Date.now(),
          },
        },
      });
    });

    const convexStarted = await startHttpServer(convexApp);
    convexServer = convexStarted.server;
    convexBaseUrl = convexStarted.url;

    // 6) Start worker queue + API wired to Redis and fake Convex.
    process.env.WORKER_SHARED_SECRET = workerSecret;
    process.env.REDIS_URL = `redis://127.0.0.1:${redisPort}`;
    process.env.CONVEX_URL = convexBaseUrl;
    process.env.WORKER_EXECUTION_BACKEND = "process";
    process.env.SNYK_TOKEN = "snyk-token-e2e";
    process.env.SONARQUBE_URL = sonarBaseUrl;
    process.env.SONARQUBE_TOKEN = "sonar-token-e2e";

    const { createVerificationQueue } = await import("../../../worker/src/queue/jobQueue");
    const { createRoutes } = await import("../../../worker/src/api/routes");
    const { authMiddleware } = await import("../../../worker/src/api/auth");

    const q = await createVerificationQueue(process.env.REDIS_URL);
    queue = q.queue;
    worker = q.worker;
    queueEvents = q.queueEvents;

    const workerApp = express();
    workerApp.use(express.json({ limit: "12mb" }));
    workerApp.use("/api", authMiddleware);
    workerApp.use("/api", createRoutes(queue));

    const workerStarted = await startHttpServer(workerApp);
    workerServer = workerStarted.server;
    workerBaseUrl = workerStarted.url;

    // Dispatch one verification job for the assertions below.
    const verifyResp = await fetch(`${workerBaseUrl}/api/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${workerSecret}`,
      },
      body: JSON.stringify({
        submissionId,
        bountyId,
        repoUrl: gitRepoDir,
        commitSha,
        jobHmac: "e2e_job_hmac",
        language: "typescript",
        timeoutSeconds: 180,
        gateSettings: {
          snykEnabled: true,
          sonarqubeEnabled: true,
        },
      }),
    });

    if (!verifyResp.ok) {
      throw new Error(`Failed to enqueue verification: ${verifyResp.status} ${await verifyResp.text()}`);
    }

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for worker callback")), 120_000);
      verificationState.resolvePayload = () => {
        clearTimeout(timeout);
        resolve();
      };

      if (verificationState.latestPayload) {
        clearTimeout(timeout);
        resolve();
      }
    });

    initConvexClient(convexBaseUrl, convexSecret);
  }, 180_000);

  afterAll(async () => {
    try {
      const { closeQueue } = await import("../../../worker/src/queue/jobQueue");
      if (worker) await worker.close().catch(() => {});
      if (queueEvents) await queueEvents.close().catch(() => {});
      if (queue) await closeQueue(queue).catch(() => {});
    } catch {
      // best effort
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
    if (sonarServer) {
      await new Promise<void>((resolve, reject) =>
        sonarServer.close((err) => (err ? reject(err) : resolve())),
      );
    }

    if (redisContainerName) {
      await execFileAsync("docker", ["rm", "-f", redisContainerName]).catch(() => {});
    }

    if (gitRepoDir) {
      await rm(gitRepoDir, { recursive: true, force: true }).catch(() => {});
    }
    if (binDir) {
      await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    }

    process.env.PATH = originalPath;
    process.env.PROCESS_BACKEND_PATH = originalProcessBackendPath;
  }, 120_000);

  it("runs verification through redis-backed worker and posts gate payload including snyk/sonarqube", () => {
    const payload = verificationState.latestPayload;
    expect(payload).toBeTruthy();
    expect(payload.submissionId).toBe(submissionId);

    const gates = payload.gates as Array<{ gate: string; status: string; details?: Record<string, unknown> }>;
    const gateNames = gates.map((g) => g.gate);
    expect(gateNames).toContain("snyk");
    expect(gateNames).toContain("sonarqube");

    const snykGate = gates.find((g) => g.gate === "snyk");
    const sonarGate = gates.find((g) => g.gate === "sonarqube");

    expect(snykGate?.status).toBe("pass");
    expect(sonarGate?.status).toBe("pass");
    expect(snykGate?.details).toBeTruthy();
    expect(sonarGate?.details).toBeTruthy();
    expect(typeof payload.feedbackJson).toBe("string");
  });

  it("relays persisted verification results to MCP get_verification_status output", async () => {
    const server = createMockServer();
    registerGetVerificationStatus(server as never);
    const handler = server.getHandler("get_verification_status");

    const result = await runWithAuth(testUser, () => handler({ submissionId }));
    expect(result.isError).toBeUndefined();
    const text = result.content[0]?.text ?? "";

    expect(text).toContain("# Verification Status");
    expect(text).toContain("snyk");
    expect(text).toContain("sonarqube");
    expect(text).toContain("Structured Feedback");
    expect(text).toContain("details");
  });
});
