#!/usr/bin/env node
import { randomUUID } from "crypto";
import { createServer, Server as HttpServer } from "http";
import express, { type Request, type Response } from "express";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { validateApiKey, extractApiKey, getApiKeyAuthCacheSize } from "./auth/apiKeyAuth";
import { loadServerConfig, assertConfig, type ServerConfig } from "./config";
import { initConvexClient, callConvex } from "./convex/client";
import { runWithAuth, setStdioAuthUser } from "./lib/context";
import { sendError } from "./lib/httpError";
import { createRateLimiter } from "./lib/rateLimit";
import { SessionStore } from "./lib/sessionStore";
import { HttpTelemetry } from "./lib/telemetry";
import { createMcpServer } from "./server";
import { initWorkerClient } from "./worker/client";
import { getWorkspaceCacheSize } from "./workspace/cache";

interface HttpRuntime {
  app: express.Express;
  close: () => Promise<void>;
  sessions: SessionStore;
}

async function authenticateRequest(req: Request): Promise<{
  ok: true;
  apiKey: string;
  userId: string;
  user: Awaited<ReturnType<typeof validateApiKey>>;
} | {
  ok: false;
  status: number;
  code: string;
  message: string;
}> {
  const apiKey = extractApiKey(req.headers.authorization);
  if (!apiKey) {
    return {
      ok: false,
      status: 401,
      code: "missing_api_key",
      message: "Missing API key",
    };
  }

  try {
    const user = await validateApiKey(apiKey);
    if (!user) {
      return {
        ok: false,
        status: 403,
        code: "invalid_api_key",
        message: "Invalid API key",
      };
    }
    return { ok: true, apiKey, userId: user.userId, user };
  } catch (error) {
    return {
      ok: false,
      status: 403,
      code: "invalid_api_key",
      message: error instanceof Error ? error.message : "Invalid API key",
    };
  }
}

export async function createHttpRuntime(config: ServerConfig): Promise<HttpRuntime> {
  const app = express();
  app.use(express.json({ limit: config.jsonBodyLimit }));

  const telemetry = new HttpTelemetry();
  const requestLimiter = createRateLimiter({
    store: config.rateLimitStore,
    redisUrl: config.rateLimitRedisUrl,
  });
  const registerLimiter = createRateLimiter({
    store: config.rateLimitStore,
    redisUrl: config.rateLimitRedisUrl,
  });
  const sessions = new SessionStore(config.sessionTtlMs, config.maxSessions);
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const cleanupTimer = setInterval(() => {
    const removed = sessions.cleanupExpired();
    if (removed === 0) return;
    for (const [sessionId, transport] of transports) {
      if (!sessions.get(sessionId)) {
        transports.delete(sessionId);
        transport.close().catch(() => {});
      }
    }
  }, 30_000);
  cleanupTimer.unref();

  const serverOptions = {
    enableWorkspaceTools: true,
    enableRegistration: true,
  };

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      service: "arcagent-mcp",
      rateLimitStore: requestLimiter.mode(),
    });
  });

  app.get("/metrics", (_req, res) => {
    res.json({
      ...telemetry.snapshot(sessions.size()),
      apiKeyCacheSize: getApiKeyAuthCacheSize(),
      workspaceCacheSize: getWorkspaceCacheSize(),
    });
  });

  app.post("/api/mcp/register", async (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const emailKey = typeof req.body?.email === "string"
      ? req.body.email.trim().toLowerCase()
      : "unknown";

    const ipAllowed = await registerLimiter.check(`register:ip:${ip}`, 20, 60_000);
    if (!ipAllowed) {
      telemetry.recordRateLimited();
      sendError(res, 429, "register_rate_limited", "Too many registration attempts", true);
      return;
    }

    const emailAllowed = await registerLimiter.check(
      `register:email:${emailKey}`,
      5,
      60_000,
    );
    if (!emailAllowed) {
      telemetry.recordRateLimited();
      sendError(res, 429, "register_rate_limited", "Too many registration attempts", true);
      return;
    }

    try {
      const { name, email, githubUsername } = req.body as {
        name?: string;
        email?: string;
        githubUsername?: string;
      };

      if (!name || !email) {
        sendError(res, 400, "bad_request", "name and email are required");
        return;
      }

      const result = await callConvex<{ userId: string; apiKey: string; keyPrefix: string }>(
        "/api/mcp/agents/create",
        {
          name,
          email,
          githubUsername,
        },
      );

      res.json({
        userId: result.userId,
        apiKey: result.apiKey,
        keyPrefix: result.keyPrefix,
        message: "Store this API key securely. It will not be shown again.",
      });
    } catch (error) {
      sendError(
        res,
        400,
        "registration_failed",
        error instanceof Error ? error.message : "Registration failed",
      );
    }
  });

  app.post("/mcp", async (req, res) => {
    if (config.startupMode === "registration-only") {
      sendError(
        res,
        503,
        "registration_only_mode",
        "MCP tool transport is disabled in registration-only startup mode",
      );
      return;
    }

    const startedAt = Date.now();
    const auth = await authenticateRequest(req);
    if (!auth.ok) {
      telemetry.recordAuthFailure();
      sendError(res, auth.status, auth.code, auth.message);
      return;
    }

    const allowed = await requestLimiter.check(`user:${auth.userId}`);
    if (!allowed) {
      telemetry.recordRateLimited();
      sendError(res, 429, "rate_limited", "Rate limit exceeded", true);
      return;
    }

    await runWithAuth(auth.user!, auth.apiKey, async () => {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (sessionId) {
        const record = sessions.get(sessionId);
        const transport = transports.get(sessionId);
        if (!record || !transport) {
          sendError(res, 400, "invalid_session", "Invalid or expired session");
          return;
        }
        if (record.userId !== auth.userId) {
          sendError(res, 403, "session_forbidden", "Session does not belong to this API key");
          return;
        }
        await transport.handleRequest(req, res, req.body);
        telemetry.recordRequest(Date.now() - startedAt);
        return;
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          sessions.setOwned(newSessionId, auth.userId);
          transports.set(newSessionId, transport);
        },
      });

      transport.onclose = () => {
        const sid = (transport as unknown as { sessionId?: string }).sessionId;
        if (!sid) return;
        sessions.delete(sid);
        transports.delete(sid);
      };

      const server = createMcpServer(serverOptions);
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      telemetry.recordRequest(Date.now() - startedAt);
    });
  });

  const validateStreamAccess = async (
    req: Request,
    res: Response,
  ): Promise<{ sessionId: string } | null> => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId) {
      sendError(res, 400, "invalid_session", "Missing mcp-session-id header");
      return null;
    }

    const record = sessions.get(sessionId);
    const transport = transports.get(sessionId);
    if (!record || !transport) {
      sendError(res, 400, "invalid_session", "Invalid or expired session");
      return null;
    }

    if (config.requireAuthOnStreams) {
      const auth = await authenticateRequest(req);
      if (!auth.ok) {
        telemetry.recordAuthFailure();
        sendError(res, auth.status, auth.code, auth.message);
        return null;
      }
      if (record.userId !== auth.userId) {
        sendError(res, 403, "session_forbidden", "Session does not belong to this API key");
        return null;
      }
    }

    return { sessionId };
  };

  app.get("/mcp", async (req, res) => {
    if (config.startupMode === "registration-only") {
      sendError(
        res,
        503,
        "registration_only_mode",
        "MCP tool transport is disabled in registration-only startup mode",
      );
      return;
    }
    const access = await validateStreamAccess(req, res);
    if (!access) return;
    const transport = transports.get(access.sessionId)!;
    await transport.handleRequest(req, res);
  });

  app.delete("/mcp", async (req, res) => {
    if (config.startupMode === "registration-only") {
      sendError(
        res,
        503,
        "registration_only_mode",
        "MCP tool transport is disabled in registration-only startup mode",
      );
      return;
    }
    const access = await validateStreamAccess(req, res);
    if (!access) return;
    const transport = transports.get(access.sessionId)!;
    await transport.handleRequest(req, res);
    transports.delete(access.sessionId);
    sessions.delete(access.sessionId);
  });

  return {
    app,
    sessions,
    close: async () => {
      clearInterval(cleanupTimer);
      sessions.clear();
      for (const transport of transports.values()) {
        await transport.close().catch(() => {});
      }
      transports.clear();
      await requestLimiter.close();
      await registerLimiter.close();
    },
  };
}

async function startStdio(config: ServerConfig): Promise<void> {
  if (config.arcagentApiKey) {
    try {
      const user = await validateApiKey(config.arcagentApiKey);
      if (!user) throw new Error("Invalid ARCAGENT_API_KEY");
      setStdioAuthUser(user, config.arcagentApiKey);
      console.error(`[MCP] Authenticated as ${user.name} (${user.email})`);
    } catch (err) {
      console.error(
        `[MCP] API key validation failed: ${err instanceof Error ? err.message : err}`,
      );
      process.exit(1);
    }
  }

  const server = createMcpServer({
    enableWorkspaceTools: true,
    enableRegistration: true,
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[MCP] Server running on stdio");
}

async function startHttp(config: ServerConfig): Promise<HttpServer> {
  const runtime = await createHttpRuntime(config);
  const server = createServer(runtime.app);
  await new Promise<void>((resolve) => {
    server.listen(config.mcpPort, resolve);
  });

  const closeServer = async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await runtime.close();
  };

  process.once("SIGINT", () => void closeServer());
  process.once("SIGTERM", () => void closeServer());

  console.log(`[MCP] HTTP server listening on port ${config.mcpPort}`);
  console.log(`[MCP] Register: POST http://localhost:${config.mcpPort}/api/mcp/register`);
  console.log(`[MCP] MCP endpoint: POST http://localhost:${config.mcpPort}/mcp`);
  return server;
}

export async function main(config = loadServerConfig()): Promise<void> {
  assertConfig(config);

  if (!config.workerSharedSecret) {
    console.warn("[MCP] WORKER_SHARED_SECRET not set — using scoped workspace tokens via Convex");
  }

  initConvexClient(config.convexUrl);
  if (config.workerSharedSecret) {
    initWorkerClient(config.workerSharedSecret);
  }

  if (config.transport === "stdio") {
    if (config.startupMode === "registration-only") {
      throw new Error("registration-only startup mode does not support stdio transport");
    }
    await startStdio(config);
  } else {
    await startHttp(config);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Failed to start MCP server:", err);
    process.exit(1);
  });
}
