import { beforeEach, describe, expect, it, vi } from "vitest";
import { runWithAuth } from "../lib/context";
import type { AuthenticatedUser } from "../lib/types";
import { registerWorkerHealth } from "./workerHealth";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function createMockServer() {
  const tools: Record<string, { handler: Function }> = {};
  return {
    tool: (name: string, _desc: string, _schema: unknown, handler: Function) => {
      tools[name] = { handler };
    },
    tools,
  };
}

const testUser: AuthenticatedUser = {
  userId: "user_worker_health",
  name: "Worker Health Tester",
  email: "worker-health@test.dev",
  role: "agent",
  scopes: ["workspace:read"],
};

describe("worker_health tool", () => {
  let handler: Function;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.WORKER_HEALTH_URL;
    delete process.env.WORKER_API_URL;
    const server = createMockServer();
    registerWorkerHealth(server as never);
    handler = server.tools.worker_health.handler;
  });

  it("uses explicit workerHost override", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "ok", checks: { redis: "ok" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await runWithAuth(testUser, () => handler({ workerHost: "https://worker.example.com:3001" }));
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain("https://worker.example.com:3001");
    expect(result.content[0].text).toContain("Health status: ok");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://worker.example.com:3001/api/health",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("falls back to WORKER_API_URL when no argument is provided", async () => {
    process.env.WORKER_API_URL = "http://worker.local:3001";
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "ok", checks: { executionBackend: "process" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await runWithAuth(testUser, () => handler({}));
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain("http://worker.local:3001");
    expect(result.content[0].text).toContain("executionBackend: process");
  });

  it("returns isError=true when health endpoint is non-200", async () => {
    process.env.WORKER_API_URL = "http://worker.local:3001";
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "degraded", checks: { redis: "fail" } }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await runWithAuth(testUser, () => handler({}));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("HTTP status: 503");
  });
});
