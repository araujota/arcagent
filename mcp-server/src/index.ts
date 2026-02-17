#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { createMcpServer } from "./server";
import { initConvexClient, callConvex } from "./convex/client";
import { generateApiKey } from "./lib/crypto";
import { validateApiKey, extractApiKey } from "./auth/apiKeyAuth";
import { checkRateLimit, startCleanupInterval } from "./lib/rateLimit";
import { runWithAuth, setStdioAuthUser } from "./lib/context";
import { initWorkerClient } from "./worker/client";
import { randomUUID } from "crypto";

// ---------------------------------------------------------------------------
// Environment validation
// ---------------------------------------------------------------------------

// IMPORTANT: Update this to your production Convex deployment URL before running
// `npm publish`. This is the URL that npx users will connect to by default.
const DEFAULT_CONVEX_URL = "https://bright-rabbit-610.convex.cloud";
const CONVEX_URL = process.env.CONVEX_URL || DEFAULT_CONVEX_URL;
const MCP_SHARED_SECRET = process.env.MCP_SHARED_SECRET;
const ARCAGENT_API_KEY = process.env.ARCAGENT_API_KEY;
const MCP_PORT = parseInt(process.env.MCP_PORT || "3002", 10);
const TRANSPORT = process.env.MCP_TRANSPORT || "stdio";
const WORKER_SHARED_SECRET = process.env.WORKER_SHARED_SECRET;

if (!MCP_SHARED_SECRET && !ARCAGENT_API_KEY) {
  console.error(
    "Either MCP_SHARED_SECRET (self-hosted) or ARCAGENT_API_KEY (npx) is required"
  );
  process.exit(1);
}

if (!WORKER_SHARED_SECRET) {
  console.warn("[MCP] WORKER_SHARED_SECRET not set — workspace tools will be unavailable");
}

if (!process.env.CLERK_SECRET_KEY) {
  console.warn("[MCP] CLERK_SECRET_KEY not set — agent registration will be unavailable");
}

// API key used as bearer token when MCP_SHARED_SECRET unavailable
const bearerToken = MCP_SHARED_SECRET || ARCAGENT_API_KEY!;
initConvexClient(CONVEX_URL, bearerToken);

// Initialize worker client for direct workspace operations
if (WORKER_SHARED_SECRET) {
  initWorkerClient(WORKER_SHARED_SECRET);
}

// ---------------------------------------------------------------------------
// Start server based on transport mode
// ---------------------------------------------------------------------------

async function main() {
  if (TRANSPORT === "stdio") {
    await startStdio();
  } else {
    await startHttp();
  }
}

// ---------------------------------------------------------------------------
// Stdio transport (for local MCP clients like Claude Desktop)
// ---------------------------------------------------------------------------

async function startStdio() {
  // When running in API key mode (npx), validate and set auth context
  if (ARCAGENT_API_KEY && !MCP_SHARED_SECRET) {
    try {
      const user = await validateApiKey(ARCAGENT_API_KEY);
      if (!user) {
        console.error("[MCP] Invalid ARCAGENT_API_KEY");
        process.exit(1);
      }
      setStdioAuthUser(user);
      console.error(`[MCP] Authenticated as ${user.name} (${user.email})`);
    } catch (err) {
      console.error(
        `[MCP] API key validation failed: ${err instanceof Error ? err.message : err}`
      );
      process.exit(1);
    }
  }

  const server = createMcpServer({
    enableWorkspaceTools: !!WORKER_SHARED_SECRET,
    enableRegistration: !!process.env.CLERK_SECRET_KEY,
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[MCP] Server running on stdio");
}

// ---------------------------------------------------------------------------
// HTTP transport (for remote MCP clients)
// ---------------------------------------------------------------------------

async function startHttp() {
  const app = express();
  app.use(express.json());

  // Health check
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "arcagent-mcp" });
  });

  // Agent self-registration endpoint (creates real Clerk user for unified accounts)
  if (process.env.CLERK_SECRET_KEY) {
    app.post("/api/mcp/register", async (req, res) => {
      try {
        const { findOrCreateClerkUser } = await import("./lib/clerk");
        const { name, email, githubUsername } = req.body as {
          name?: string;
          email?: string;
          githubUsername?: string;
        };

        if (!name || !email) {
          res.status(400).json({ error: "name and email are required" });
          return;
        }

        // Create or find existing Clerk user (unified accounts)
        const { clerkId, isExisting } = await findOrCreateClerkUser(
          name,
          email,
          githubUsername,
        );

        // Generate API key
        const { plaintext, hash, prefix } = generateApiKey();

        // Create or link agent in Convex
        const result = await callConvex<{ userId: string }>(
          "/api/mcp/agents/create",
          {
            name,
            email,
            clerkId,
            keyHash: hash,
            keyPrefix: prefix,
            githubUsername,
          },
        );

        res.json({
          userId: result.userId,
          apiKey: plaintext,
          keyPrefix: prefix,
          isExistingAccount: isExisting,
          message:
            "Store this API key securely. It will not be shown again.",
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Registration failed";
        res.status(400).json({ error: message });
      }
    });
  }

  // MCP Streamable HTTP transport
  // Each session gets its own MCP server instance
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const serverOptions = {
    enableWorkspaceTools: !!WORKER_SHARED_SECRET,
    enableRegistration: !!process.env.CLERK_SECRET_KEY,
  };

  app.post("/mcp", async (req, res) => {
    // Authenticate the request
    const apiKey = extractApiKey(req.headers.authorization);
    if (!apiKey) {
      res.status(401).json({ error: "Missing API key" });
      return;
    }

    let user;
    try {
      user = await validateApiKey(apiKey);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invalid API key";
      res.status(403).json({ error: message });
      return;
    }
    if (!user) {
      res.status(403).json({ error: "Invalid API key" });
      return;
    }

    // Rate limit
    if (!checkRateLimit(user.userId)) {
      res.status(429).json({ error: "Rate limit exceeded" });
      return;
    }

    // SECURITY (C1): Populate AsyncLocalStorage auth context so tool
    // handlers can read the authenticated user without accepting agentId params.
    await runWithAuth(user, async () => {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (sessionId && sessions.has(sessionId)) {
        // Existing session
        const transport = sessions.get(sessionId)!;
        await transport.handleRequest(req, res, req.body);
      } else {
        // New session
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            sessions.set(newSessionId, transport);
          },
        });

        transport.onclose = () => {
          const sid = (transport as unknown as Record<string, unknown>).sessionId as string;
          if (sid) sessions.delete(sid);
        };

        const server = createMcpServer(serverOptions);
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      }
    });
  });

  // Handle GET for SSE streams
  app.get("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !sessions.has(sessionId)) {
      res.status(400).json({ error: "Invalid session" });
      return;
    }

    const transport = sessions.get(sessionId)!;
    await transport.handleRequest(req, res);
  });

  // Handle DELETE for session cleanup
  app.delete("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (sessionId && sessions.has(sessionId)) {
      const transport = sessions.get(sessionId)!;
      await transport.handleRequest(req, res);
      sessions.delete(sessionId);
    } else {
      res.status(200).json({ ok: true });
    }
  });

  // Start rate limit cleanup
  startCleanupInterval();

  app.listen(MCP_PORT, () => {
    console.log(`[MCP] HTTP server listening on port ${MCP_PORT}`);
    if (process.env.CLERK_SECRET_KEY) {
      console.log(`[MCP] Register: POST http://localhost:${MCP_PORT}/api/mcp/register`);
    }
    console.log(`[MCP] MCP endpoint: POST http://localhost:${MCP_PORT}/mcp`);
  });
}

main().catch((err) => {
  console.error("Failed to start MCP server:", err);
  process.exit(1);
});
