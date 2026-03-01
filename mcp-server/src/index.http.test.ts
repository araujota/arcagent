import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import type { ServerConfig } from "./config";
import { createHttpRuntime } from "./index";

const {
  validateApiKeyMock,
  callConvexMock,
} = vi.hoisted(() => ({
  validateApiKeyMock: vi.fn(),
  callConvexMock: vi.fn(),
}));

let sessionCounter = 0;

vi.mock("./auth/apiKeyAuth", () => ({
  extractApiKey: (header?: string) =>
    header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null,
  validateApiKey: validateApiKeyMock,
  getApiKeyAuthCacheSize: () => 0,
}));

vi.mock("./convex/client", () => ({
  initConvexClient: vi.fn(),
  callConvex: callConvexMock,
}));

vi.mock("./server", () => ({
  createMcpServer: () => ({
    connect: vi.fn(async () => {}),
  }),
}));

vi.mock("@modelcontextprotocol/sdk/server/streamableHttp.js", () => ({
  StreamableHTTPServerTransport: class FakeTransport {
    public sessionId?: string;
    public onclose?: () => void;
    constructor(
      private opts?: {
        onsessioninitialized?: (sid: string) => void;
        sessionIdGenerator?: (() => string) | undefined;
      },
    ) {}

    async handleRequest(req: { method?: string; headers?: Record<string, string> }, res: {
      status: (code: number) => { json: (body: unknown) => void };
      json: (body: unknown) => void;
    }): Promise<void> {
      const stateful = this.opts?.sessionIdGenerator !== undefined;
      if (stateful && !this.sessionId && req.method === "POST") {
        sessionCounter += 1;
        this.sessionId = `sid-${sessionCounter}`;
        this.opts?.onsessioninitialized?.(this.sessionId);
        res.status(200).json({ ok: true, sessionId: this.sessionId });
        return;
      }
      res.status(200).json({ ok: true, sessionId: this.sessionId ?? null });
    }

    async close(): Promise<void> {
      this.onclose?.();
    }
  },
}));

function baseConfig(overrides?: Partial<ServerConfig>): ServerConfig {
  return {
    convexUrl: "https://example.convex.cloud",
    arcagentApiKey: undefined,
    workerSharedSecret: undefined,
    clerkSecretKey: undefined,
    mcpPort: 0,
    transport: "http",
    requireAuthOnStreams: true,
    sessionTtlMs: 900_000,
    maxSessions: 5000,
    jsonBodyLimit: "1mb",
    rateLimitStore: "memory",
    rateLimitRedisUrl: undefined,
    startupMode: "full",
    sessionMode: "stateful",
    publicBaseUrl: undefined,
    allowedHosts: [],
    requireHttps: false,
    registerHoneypotField: "website",
    registerCaptchaHeader: "x-arcagent-captcha-token",
    registerCaptchaSecret: undefined,
    enableConvexAuditLogs: false,
    convexAuditLogToken: undefined,
    ...overrides,
  };
}

async function startRuntime(config: ServerConfig): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const runtime = await createHttpRuntime(config);
  const server = createServer(runtime.app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: async () => {
      await runtime.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("HTTP MCP auth/session hardening", () => {
  beforeEach(() => {
    validateApiKeyMock.mockReset();
    callConvexMock.mockReset();
    sessionCounter = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("POST /mcp requires Authorization", async () => {
    const runtime = await startRuntime(baseConfig());
    try {
      const resp = await fetch(`${runtime.url}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(resp.status).toBe(401);
      const body = await resp.json() as { error: { code: string } };
      expect(body.error.code).toBe("missing_api_key");
    } finally {
      await runtime.close();
    }
  });

  it("allows registration without API key and returns Convex-issued key", async () => {
    callConvexMock.mockResolvedValue({
      userId: "user_1",
      apiKey: "arc_generated_from_convex_123456789012",
      keyPrefix: "arc_gene",
    });

    const runtime = await startRuntime(baseConfig());
    try {
      const resp = await fetch(`${runtime.url}/api/mcp/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Alice",
          email: "alice@test.dev",
        }),
      });

      expect(resp.status).toBe(200);
      const body = await resp.json() as { userId: string; apiKey: string };
      expect(body.userId).toBe("user_1");
      expect(body.apiKey).toContain("arc_");
    } finally {
      await runtime.close();
    }
  });

  it("always exposes /api/mcp/register", async () => {
    callConvexMock.mockResolvedValue({
      userId: "user_2",
      apiKey: "arc_generated_from_convex_222222222222",
      keyPrefix: "arc_gene",
    });
    const runtime = await startRuntime(baseConfig());
    try {
      const resp = await fetch(`${runtime.url}/api/mcp/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Alice",
          email: "alice@test.dev",
        }),
      });

      expect(resp.status).toBe(200);
    } finally {
      await runtime.close();
    }
  });

  it("validates registration payload and returns bad_request for missing fields", async () => {
    const runtime = await startRuntime(baseConfig());
    try {
      const resp = await fetch(`${runtime.url}/api/mcp/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Alice",
        }),
      });

      expect(resp.status).toBe(400);
      const body = await resp.json() as { error: { code: string; message: string } };
      expect(body.error.code).toBe("bad_request");
      expect(body.error.message).toContain("name and email are required");
      expect(callConvexMock).not.toHaveBeenCalled();
    } finally {
      await runtime.close();
    }
  });

  it("rate limits registration attempts by email", async () => {
    callConvexMock.mockResolvedValue({
      userId: "user_limited",
      apiKey: "arc_generated_from_convex_limited_1234",
      keyPrefix: "arc_gene",
    });

    const runtime = await startRuntime(baseConfig());
    try {
      for (let i = 0; i < 5; i += 1) {
        const resp = await fetch(`${runtime.url}/api/mcp/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: `Agent ${i}`,
            email: "limit@test.dev",
          }),
        });
        expect(resp.status).toBe(200);
      }

      const limitedResp = await fetch(`${runtime.url}/api/mcp/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Agent blocked",
          email: "limit@test.dev",
        }),
      });
      expect(limitedResp.status).toBe(429);
      const body = await limitedResp.json() as { error: { code: string } };
      expect(body.error.code).toBe("register_rate_limited");
    } finally {
      await runtime.close();
    }
  });

  it("supports register-to-auth flow: issued key can open MCP session", async () => {
    const issuedKey = "arc_generated_from_convex_auth_flow_1234";
    callConvexMock.mockResolvedValue({
      userId: "user-auth-flow",
      apiKey: issuedKey,
      keyPrefix: "arc_gene",
    });
    validateApiKeyMock.mockImplementation(async (key: string) => {
      if (key === issuedKey) {
        return {
          userId: "user-auth-flow",
          name: "Auth Flow",
          email: "authflow@test.dev",
          role: "agent",
          scopes: ["bounties:read", "submissions:write"],
        };
      }
      return null;
    });

    const runtime = await startRuntime(baseConfig());
    try {
      const registerResp = await fetch(`${runtime.url}/api/mcp/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Auth Flow",
          email: "authflow@test.dev",
        }),
      });
      expect(registerResp.status).toBe(200);
      const registerBody = await registerResp.json() as { apiKey: string; userId: string };
      expect(registerBody.apiKey).toBe(issuedKey);
      expect(registerBody.userId).toBe("user-auth-flow");

      const sessionResp = await fetch(`${runtime.url}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${registerBody.apiKey}`,
        },
        body: JSON.stringify({}),
      });
      expect(sessionResp.status).toBe(200);
      const sessionBody = await sessionResp.json() as { sessionId: string };
      expect(sessionBody.sessionId).toBe("sid-1");
    } finally {
      await runtime.close();
    }
  });

  it("registration-only startup mode disables /mcp tool transport", async () => {
    callConvexMock.mockResolvedValue({
      userId: "user_2",
      apiKey: "arc_generated_from_convex_222222222222",
      keyPrefix: "arc_gene",
    });

    const runtime = await startRuntime(baseConfig({
      startupMode: "registration-only",
    }));
    try {
      const mcpResp = await fetch(`${runtime.url}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(mcpResp.status).toBe(503);

      const registerResp = await fetch(`${runtime.url}/api/mcp/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Alice",
          email: "alice@test.dev",
        }),
      });
      expect(registerResp.status).toBe(200);
      const body = await registerResp.json() as { apiKey: string };
      expect(body.apiKey).toContain("arc_");
    } finally {
      await runtime.close();
    }
  });

  it("GET and DELETE /mcp require Authorization when stream auth is enabled", async () => {
    validateApiKeyMock.mockResolvedValue({
      userId: "u1",
      name: "A",
      email: "a@test.dev",
      role: "agent",
      scopes: ["bounties:read"],
    });
    const runtime = await startRuntime(baseConfig());
    try {
      await fetch(`${runtime.url}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer arc_key_1",
        },
        body: JSON.stringify({}),
      });

      const getResp = await fetch(`${runtime.url}/mcp`, {
        method: "GET",
        headers: {
          "mcp-session-id": "sid-1",
        },
      });
      expect(getResp.status).toBe(401);

      const delResp = await fetch(`${runtime.url}/mcp`, {
        method: "DELETE",
        headers: {
          "mcp-session-id": "sid-1",
        },
      });
      expect(delResp.status).toBe(401);
    } finally {
      await runtime.close();
    }
  });

  it("rejects cross-user session access", async () => {
    validateApiKeyMock.mockImplementation(async (key: string) => {
      if (key === "arc_key_A") {
        return {
          userId: "user-A",
          name: "A",
          email: "a@test.dev",
          role: "agent",
          scopes: ["bounties:read"],
        };
      }
      if (key === "arc_key_B") {
        return {
          userId: "user-B",
          name: "B",
          email: "b@test.dev",
          role: "agent",
          scopes: ["bounties:read"],
        };
      }
      return null;
    });

    const runtime = await startRuntime(baseConfig());
    try {
      const createResp = await fetch(`${runtime.url}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer arc_key_A",
        },
        body: JSON.stringify({}),
      });
      expect(createResp.status).toBe(200);

      const forbiddenResp = await fetch(`${runtime.url}/mcp`, {
        method: "GET",
        headers: {
          Authorization: "Bearer arc_key_B",
          "mcp-session-id": "sid-1",
        },
      });
      expect(forbiddenResp.status).toBe(403);
      const body = await forbiddenResp.json() as { error: { code: string } };
      expect(body.error.code).toBe("session_forbidden");
    } finally {
      await runtime.close();
    }
  });

  it("returns deterministic invalid session response after TTL expiry", async () => {
    validateApiKeyMock.mockResolvedValue({
      userId: "user-A",
      name: "A",
      email: "a@test.dev",
      role: "agent",
      scopes: ["bounties:read"],
    });
    const runtime = await startRuntime(baseConfig({ sessionTtlMs: 5 }));
    try {
      await fetch(`${runtime.url}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer arc_key_A",
        },
        body: JSON.stringify({}),
      });
      await new Promise((resolve) => setTimeout(resolve, 20));

      const resp = await fetch(`${runtime.url}/mcp`, {
        method: "GET",
        headers: {
          Authorization: "Bearer arc_key_A",
          "mcp-session-id": "sid-1",
        },
      });
      expect(resp.status).toBe(400);
      const body = await resp.json() as { error: { code: string } };
      expect(body.error.code).toBe("invalid_session");
    } finally {
      await runtime.close();
    }
  });

  it("rejects requests for hosts outside MCP_ALLOWED_HOSTS", async () => {
    const runtime = await startRuntime(baseConfig({
      allowedHosts: ["mcp.arcagent.dev"],
    }));
    try {
      const resp = await fetch(`${runtime.url}/mcp`, {
        method: "POST",
        headers: {
          Host: "invalid.arcagent.dev",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
      expect(resp.status).toBe(403);
      const body = await resp.json() as { error: { code: string } };
      expect(body.error.code).toBe("host_not_allowed");
    } finally {
      await runtime.close();
    }
  });

  it("requires HTTPS when MCP_REQUIRE_HTTPS is enabled", async () => {
    const runtime = await startRuntime(baseConfig({
      requireHttps: true,
    }));
    try {
      const resp = await fetch(`${runtime.url}/mcp`, {
        method: "POST",
        headers: {
          "X-Forwarded-Proto": "http",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
      expect(resp.status).toBe(400);
      const body = await resp.json() as { error: { code: string } };
      expect(body.error.code).toBe("https_required");
    } finally {
      await runtime.close();
    }
  });

  it("supports stateless mode for POST /mcp and blocks stream methods", async () => {
    validateApiKeyMock.mockResolvedValue({
      userId: "user-stateless",
      name: "A",
      email: "a@test.dev",
      role: "agent",
      scopes: ["bounties:read"],
    });

    const runtime = await startRuntime(baseConfig({
      sessionMode: "stateless",
    }));
    try {
      const postResp = await fetch(`${runtime.url}/mcp`, {
        method: "POST",
        headers: {
          Authorization: "Bearer arc_key_stateless",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
      expect(postResp.status).toBe(200);
      const postBody = await postResp.json() as { sessionId: string | null };
      expect(postBody.sessionId).toBeNull();

      const getResp = await fetch(`${runtime.url}/mcp`, {
        method: "GET",
      });
      expect(getResp.status).toBe(409);
      const getBody = await getResp.json() as { error: { code: string } };
      expect(getBody.error.code).toBe("session_mode_stateless");
    } finally {
      await runtime.close();
    }
  });

  it("blocks registration when honeypot field is filled", async () => {
    const runtime = await startRuntime(baseConfig({
      registerHoneypotField: "website",
    }));
    try {
      const resp = await fetch(`${runtime.url}/api/mcp/register`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "Alice",
          email: "alice@test.dev",
          website: "https://spam.example",
        }),
      });
      expect(resp.status).toBe(202);
      expect(callConvexMock).not.toHaveBeenCalled();
    } finally {
      await runtime.close();
    }
  });
});
