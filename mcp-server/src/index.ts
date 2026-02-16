import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { createMcpServer } from "./server";
import { initConvexClient, callConvex } from "./convex/client";
import { generateApiKey } from "./lib/crypto";
import { validateApiKey, extractApiKey } from "./auth/apiKeyAuth";
import { checkRateLimit, startCleanupInterval } from "./lib/rateLimit";
import { runWithAuth } from "./lib/context";
import { findOrCreateClerkUser } from "./lib/clerk";
import { initWorkerClient } from "./worker/client";
import { randomUUID } from "crypto";

// ---------------------------------------------------------------------------
// Environment validation
// ---------------------------------------------------------------------------

const CONVEX_URL = process.env.CONVEX_URL;
const MCP_SHARED_SECRET = process.env.MCP_SHARED_SECRET;
const MCP_PORT = parseInt(process.env.MCP_PORT || "3002", 10);
const TRANSPORT = process.env.MCP_TRANSPORT || "stdio";
const WORKER_SHARED_SECRET = process.env.WORKER_SHARED_SECRET;

if (!CONVEX_URL) {
  console.error("CONVEX_URL is required");
  process.exit(1);
}

if (!MCP_SHARED_SECRET) {
  console.error("MCP_SHARED_SECRET is required");
  process.exit(1);
}

if (!WORKER_SHARED_SECRET) {
  console.warn("[MCP] WORKER_SHARED_SECRET not set — workspace tools will be unavailable");
}

if (!process.env.CLERK_SECRET_KEY) {
  console.warn("[MCP] CLERK_SECRET_KEY not set — agent registration will be unavailable");
}

// Initialize Convex HTTP client
initConvexClient(CONVEX_URL, MCP_SHARED_SECRET);

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
  const server = createMcpServer();
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
    res.json({ status: "ok", service: "arcagent-mcp-server" });
  });

  // Agent self-registration endpoint (creates real Clerk user for unified accounts)
  app.post("/api/mcp/register", async (req, res) => {
    try {
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

  // MCP Streamable HTTP transport
  // Each session gets its own MCP server instance
  const sessions = new Map<string, StreamableHTTPServerTransport>();

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

        const server = createMcpServer();
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
    console.log(`[MCP] Register: POST http://localhost:${MCP_PORT}/api/mcp/register`);
    console.log(`[MCP] MCP endpoint: POST http://localhost:${MCP_PORT}/mcp`);
  });
}

main().catch((err) => {
  console.error("Failed to start MCP server:", err);
  process.exit(1);
});
