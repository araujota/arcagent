import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../workspace/cache", () => ({ getWorkspaceForAgent: vi.fn() }));

import { getWorkspaceForAgent } from "../workspace/cache";
import { runWithAuth } from "../lib/context";
import { AuthenticatedUser } from "../lib/types";
import { registerCheckWorkerStatus } from "./checkWorkerStatus";

const mockGetWorkspaceForAgent = vi.mocked(getWorkspaceForAgent);
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
  userId: "user_worker",
  name: "Worker Tester",
  email: "worker@test.dev",
  role: "agent",
  scopes: ["workspace:read"],
};

describe("check_worker_status tool", () => {
  let handler: Function;

  beforeEach(() => {
    vi.clearAllMocks();
    const server = createMockServer();
    registerCheckWorkerStatus(server as never);
    handler = server.tools["check_worker_status"].handler;
  });

  it("returns usage guidance when bountyId is omitted", async () => {
    const result = await runWithAuth(testUser, () => handler({}));
    expect(result.content[0].text).toContain("Provide a `bountyId`");
  });

  it("returns error when no workspace is found", async () => {
    mockGetWorkspaceForAgent.mockResolvedValueOnce({
      found: false,
      reason: "workspace_not_yet_created",
    });

    const result = await runWithAuth(testUser, () => handler({ bountyId: "bounty_1" }));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Workspace is not ready yet");
  });

  it("pings worker /api/health and returns status details", async () => {
    mockGetWorkspaceForAgent.mockResolvedValueOnce({
      found: true,
      workspaceId: "ws_1",
      workerHost: "https://worker.example.com",
      status: "ready",
      expiresAt: Date.now() + 60_000,
    });

    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: "ok",
          timestamp: "2026-02-26T04:00:00.000Z",
          checks: { redis: "ok", firecracker: "ok" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await runWithAuth(testUser, () => handler({ bountyId: "bounty_1" }));
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain("HTTP status: 200");
    expect(result.content[0].text).toContain("Health status: ok");
    expect(result.content[0].text).toContain("redis: ok");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://worker.example.com/api/health",
      expect.objectContaining({ method: "GET" }),
    );
  });
});
