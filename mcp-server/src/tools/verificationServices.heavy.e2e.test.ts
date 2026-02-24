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

async function waitForUrl(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(url);
      if (resp.ok) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function waitForSonarUp(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`${baseUrl}/api/system/status`);
      if (resp.ok) {
        const json = (await resp.json()) as { status?: string };
        if (json.status === "UP") return;
      }
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Timed out waiting for SonarQube to reach UP at ${baseUrl}`);
}

async function configureSonarAndGetToken(baseUrl: string): Promise<string> {
  const newPassword = "adminStrong123!";
  // Best effort password rotation from default.
  await fetch(`${baseUrl}/api/users/change_password`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from("admin:admin").toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      login: "admin",
      previousPassword: "admin",
      password: newPassword,
    }),
  }).catch(() => {});

  const authCandidates = [
    `Basic ${Buffer.from(`admin:${newPassword}`).toString("base64")}`,
    `Basic ${Buffer.from("admin:admin").toString("base64")}`,
  ];

  for (const auth of authCandidates) {
    const resp = await fetch(`${baseUrl}/api/user_tokens/generate`, {
      method: "POST",
      headers: {
        Authorization: auth,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ name: `e2e-token-${Date.now()}` }),
    });

    if (!resp.ok) continue;
    const json = (await resp.json()) as { token?: string };
    if (json.token) return json.token;
  }

  throw new Error("Failed to generate SonarQube token for heavy e2e test");
}

describe.skipIf(process.env.RUN_HEAVY_E2E !== "1")(
  "heavy e2e: real SonarQube boot + Redis + worker + MCP relay",
  () => {
    let tempRoot = "";
    let binDir = "";
    let repoDir = "";
    let composeDir = "";
    let composeFile = "";
    let composeProject = "";
    let redisContainerName = "";
    const originalPath = process.env.PATH ?? "";

    let workerServer: Server;
    let convexServer: Server;
    let workerBaseUrl = "";
    let convexBaseUrl = "";
    let sonarBaseUrl = "";
    let sonarToken = "";

    let queue: Awaited<ReturnType<typeof import("../../../worker/src/queue/jobQueue").createVerificationQueue>>["queue"];
    let worker: Awaited<ReturnType<typeof import("../../../worker/src/queue/jobQueue").createVerificationQueue>>["worker"];
    let queueEvents: Awaited<ReturnType<typeof import("../../../worker/src/queue/jobQueue").createVerificationQueue>>["queueEvents"];

    const redisPort = 26379;
    const sonarPort = 29000;
    const workerSecret = "worker-secret-heavy-e2e";
    const convexSecret = "convex-secret-heavy-e2e";
    const submissionId = "submission-heavy-e2e-1";
    const bountyId = "bounty-heavy-e2e-1";

    const verificationState: {
      latestPayload: any | null;
      resolvePayload?: (value: any) => void;
    } = {
      latestPayload: null,
    };

    const testUser: AuthenticatedUser = {
      userId: "user-heavy-e2e-1",
      name: "Heavy E2E Agent",
      email: "heavy-e2e@agent.dev",
      role: "agent",
      scopes: ["bounties:read"],
    };

    beforeAll(async () => {
      tempRoot = await mkdtemp(join(tmpdir(), "arcagent-heavy-e2e-"));
      binDir = join(tempRoot, "bin");
      repoDir = join(tempRoot, "repo");
      composeDir = join(tempRoot, "sonar-stack");
      composeFile = join(composeDir, "docker-compose.yml");
      composeProject = `arcagentheavy${Date.now()}`;
      redisContainerName = `arcagent-heavy-redis-${Date.now()}`;

      await mkdir(binDir, { recursive: true });
      await mkdir(repoDir, { recursive: true });
      await mkdir(composeDir, { recursive: true });

      // Start Redis in Docker (real queue backend)
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

      for (let i = 0; i < 30; i++) {
        try {
          const { stdout } = await execFileAsync("docker", ["exec", redisContainerName, "redis-cli", "ping"]);
          if (stdout.trim() === "PONG") break;
        } catch {
          // retry
        }
        if (i === 29) throw new Error("Redis did not become ready in heavy e2e");
        await new Promise((r) => setTimeout(r, 1000));
      }

      // Boot real SonarQube + Postgres via compose.
      await writeFile(
        composeFile,
        `services:\n  db:\n    image: postgres:15-alpine\n    environment:\n      POSTGRES_USER: sonarqube\n      POSTGRES_PASSWORD: sonarqube\n      POSTGRES_DB: sonarqube\n    healthcheck:\n      test: [\"CMD-SHELL\", \"pg_isready -U sonarqube -d sonarqube\"]\n      interval: 10s\n      timeout: 5s\n      retries: 10\n  sonarqube:\n    image: sonarqube:community\n    ports:\n      - \"${sonarPort}:9000\"\n    environment:\n      SONAR_JDBC_URL: jdbc:postgresql://db:5432/sonarqube\n      SONAR_JDBC_USERNAME: sonarqube\n      SONAR_JDBC_PASSWORD: sonarqube\n    depends_on:\n      db:\n        condition: service_healthy\n`,
        "utf-8",
      );

      await execFileAsync("docker", [
        "compose",
        "-p",
        composeProject,
        "-f",
        composeFile,
        "up",
        "-d",
      ]);

      sonarBaseUrl = `http://127.0.0.1:${sonarPort}`;
      await waitForUrl(`${sonarBaseUrl}/api/system/status`, 8 * 60_000);
      await waitForSonarUp(sonarBaseUrl, 8 * 60_000);

      sonarToken = await configureSonarAndGetToken(sonarBaseUrl);

      // Real sonar-scanner via official Docker image wrapper; real Snyk still mocked.
      const sonarWrapper = `#!/usr/bin/env bash
set -euo pipefail
ARGS=()
for arg in "$@"; do
  if [[ "$arg" == -Dsonar.host.url=http://127.0.0.1:* ]]; then
    arg="-Dsonar.host.url=http://host.docker.internal:\${arg##*:}"
  fi
  if [[ "$arg" == -Dsonar.host.url=http://localhost:* ]]; then
    arg="-Dsonar.host.url=http://host.docker.internal:\${arg##*:}"
  fi
  ARGS+=("$arg")
done
exec docker run --rm -v "$(pwd):/usr/src" -w /usr/src -e SONAR_TOKEN="\${SONAR_TOKEN:-}" sonarsource/sonar-scanner-cli:latest "\${ARGS[@]}"
`;

      const snykScript = `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"code test"* ]]; then
  cat <<'JSON'\n{"runs":[{"results":[]}]}\nJSON
  exit 0
fi
cat <<'JSON'\n{"vulnerabilities":[]}\nJSON
exit 0
`;

      await writeFile(join(binDir, "sonar-scanner"), sonarWrapper, "utf-8");
      await writeFile(join(binDir, "snyk"), snykScript, "utf-8");
      await chmod(join(binDir, "sonar-scanner"), 0o755);
      await chmod(join(binDir, "snyk"), 0o755);
      process.env.PATH = `${binDir}:${originalPath}`;

      // Test repo
      await writeFile(
        join(repoDir, "package.json"),
        JSON.stringify(
          {
            name: "heavy-e2e-repo",
            version: "1.0.0",
            private: true,
            scripts: { test: "echo ok" },
            devDependencies: { typescript: "^5.0.0", eslint: "^9.0.0" },
          },
          null,
          2,
        ),
        "utf-8",
      );
      await writeFile(join(repoDir, "eslint.config.mjs"), "export default [];\n", "utf-8");
      await writeFile(join(repoDir, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2020" }, include: ["src/**/*.ts"] }), "utf-8");
      await mkdir(join(repoDir, "src"), { recursive: true });
      await writeFile(join(repoDir, "src", "index.ts"), "export const x = 1;\n", "utf-8");

      await execFileAsync("npm", ["install", "--package-lock-only"], { cwd: repoDir });
      await execFileAsync("git", ["init"], { cwd: repoDir });
      await execFileAsync("git", ["config", "user.email", "heavy-e2e@test.dev"], { cwd: repoDir });
      await execFileAsync("git", ["config", "user.name", "Heavy E2E"], { cwd: repoDir });
      await execFileAsync("git", ["add", "."], { cwd: repoDir });
      await execFileAsync("git", ["commit", "-m", "init"], { cwd: repoDir });
      const { stdout: commitOut } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoDir });
      const commitSha = commitOut.trim();

      // Fake Convex
      const convexApp = express();
      convexApp.use(express.json({ limit: "12mb" }));

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

      convexApp.post("/api/mcp/verifications/get", (req, res) => {
        if (req.header("authorization") !== `Bearer ${convexSecret}`) {
          res.status(403).json({ error: "Forbidden" });
          return;
        }
        if (!verificationState.latestPayload) {
          res.status(404).json({ error: "Verification not found" });
          return;
        }
        const payload = verificationState.latestPayload;
        const status = payload.overallStatus === "pass" ? "passed" : payload.overallStatus;

        res.json({
          verification: {
            _id: "verification-heavy-e2e-1",
            submissionId: payload.submissionId,
            bountyId: payload.bountyId,
            status,
            gates: (payload.gates ?? []).map((g: any) => ({
              gateType: g.gate,
              tool: g.summary ?? g.gate,
              status: g.status === "pass" ? "passed" : g.status === "fail" ? "failed" : "warning",
              issues: g.summary ? [g.summary] : [],
              details: g.details,
            })),
            steps: payload.steps ?? [],
            feedbackJson: payload.feedbackJson ?? null,
            job: {
              status,
              queuedAt: Date.now() - 5000,
              completedAt: Date.now(),
            },
          },
        });
      });

      const convexStarted = await startHttpServer(convexApp);
      convexServer = convexStarted.server;
      convexBaseUrl = convexStarted.url;

      // Worker queue + API
      process.env.WORKER_SHARED_SECRET = workerSecret;
      process.env.REDIS_URL = `redis://127.0.0.1:${redisPort}`;
      process.env.CONVEX_URL = convexBaseUrl;
      process.env.WORKER_EXECUTION_BACKEND = "process";
      process.env.SNYK_TOKEN = "heavy-snyk-token";
      process.env.SONARQUBE_URL = sonarBaseUrl;
      process.env.SONARQUBE_TOKEN = sonarToken;

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

      const verifyResp = await fetch(`${workerBaseUrl}/api/verify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${workerSecret}`,
        },
        body: JSON.stringify({
          submissionId,
          bountyId,
          repoUrl: repoDir,
          commitSha,
          language: "typescript",
          timeoutSeconds: 300,
          gateSettings: {
            snykEnabled: true,
            sonarqubeEnabled: true,
          },
        }),
      });

      if (!verifyResp.ok) {
        throw new Error(`Failed to enqueue heavy verification: ${verifyResp.status} ${await verifyResp.text()}`);
      }

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timed out waiting for heavy verification callback")), 10 * 60_000);
        verificationState.resolvePayload = () => {
          clearTimeout(timeout);
          resolve();
        };
      });

      initConvexClient(convexBaseUrl, convexSecret);
    }, 12 * 60_000);

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
        ).catch(() => {});
      }
      if (convexServer) {
        await new Promise<void>((resolve, reject) =>
          convexServer.close((err) => (err ? reject(err) : resolve())),
        ).catch(() => {});
      }

      if (composeFile) {
        await execFileAsync("docker", ["compose", "-p", composeProject, "-f", composeFile, "down", "-v"]).catch(() => {});
      }
      if (redisContainerName) {
        await execFileAsync("docker", ["rm", "-f", redisContainerName]).catch(() => {});
      }

      if (tempRoot) {
        await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
      }

      process.env.PATH = originalPath;
    }, 3 * 60_000);

    it("runs against real SonarQube boot and relays Sonar/Snyk results to MCP", async () => {
      const payload = verificationState.latestPayload;
      expect(payload).toBeTruthy();

      const gates = payload.gates as Array<{ gate: string; status: string }>;
      const gateNames = gates.map((g) => g.gate);
      expect(gateNames).toContain("snyk");
      expect(gateNames).toContain("sonarqube");

      const sonarGate = gates.find((g) => g.gate === "sonarqube");
      if (sonarGate?.status !== "pass") {
        throw new Error(`Expected Sonar gate pass, got: ${JSON.stringify(sonarGate)}`);
      }

      const server = createMockServer();
      registerGetVerificationStatus(server as never);
      const handler = server.getHandler("get_verification_status");

      const mcpResult = await runWithAuth(testUser, () => handler({ submissionId }));
      expect(mcpResult.isError).toBeUndefined();
      const text = mcpResult.content[0]?.text ?? "";
      expect(text).toContain("sonarqube");
      expect(text).toContain("snyk");
      expect(text).toContain("Structured Feedback");
    }, 2 * 60_000);
  },
);
