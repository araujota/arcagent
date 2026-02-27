import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../convex/client", () => ({ callConvex: vi.fn() }));

import { callConvex } from "../convex/client";
import { registerWorkspaceStartupLog } from "./workspaceStartupLog";
import { runWithAuth } from "../lib/context";
import type { AuthenticatedUser } from "../lib/types";

const mockCallConvex = vi.mocked(callConvex);

function createMockServer() {
  const tools: Record<string, { handler: Function }> = {};
  return {
    tool: (name: string, _description: string, _schema: unknown, handler: Function) => {
      tools[name] = { handler };
    },
    tools,
  };
}

const testUser: AuthenticatedUser = {
  userId: "agent_123",
  name: "Agent",
  email: "agent@test.dev",
  role: "agent",
  scopes: ["workspace:read"],
};

describe("workspace_startup_log tool", () => {
  let handler: Function;

  beforeEach(() => {
    vi.clearAllMocks();
    const server = createMockServer();
    registerWorkspaceStartupLog(server as any);
    handler = server.tools.workspace_startup_log.handler;
  });

  it("returns formatted diagnostics", async () => {
    mockCallConvex.mockResolvedValue({
      found: true,
      bountyId: "b1",
      claimId: "c1",
      workspaceId: "w1",
      startupLog: {
        mode: "shared_worker",
        workspaceStatus: "error",
        workerHost: "https://w1.speedlesvc.com",
        workspaceError: "Worker API error: 500 - boom",
        vmBootStage: "vsock_wait",
        firecrackerExitCode: 1,
        firecrackerStderrTail: "open /dev/dm-0: permission denied",
        rootfsAccessCheck: "permission_denied",
        workerHealth: {
          reachable: false,
          error: "connect ECONNREFUSED",
        },
      },
    });

    const result = await runWithAuth(testUser, () => handler({ bountyId: "b1" }));

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Workspace Startup Diagnostics");
    expect(result.content[0].text).toContain("Mode: shared_worker");
    expect(result.content[0].text).toContain("Workspace status: error");
    expect(result.content[0].text).toContain("VM boot stage: vsock_wait");
    expect(result.content[0].text).toContain("Firecracker exit code: 1");
    expect(result.content[0].text).toContain("Rootfs access check: permission_denied");
    expect(mockCallConvex).toHaveBeenCalledWith("/api/mcp/workspace/startup-log", {
      bountyId: "b1",
      workspaceId: undefined,
      claimId: undefined,
    });
  });

  it("returns error when no selector is provided", async () => {
    const result = await runWithAuth(testUser, () => handler({}));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Provide one of");
  });

  it("returns endpoint errors", async () => {
    mockCallConvex.mockRejectedValue(new Error("boom"));

    const result = await runWithAuth(testUser, () => handler({ bountyId: "b1" }));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("boom");
  });
});
