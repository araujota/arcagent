import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../convex/client", () => ({ callConvex: vi.fn() }));
vi.mock("../worker/client", () => ({ callWorker: vi.fn() }));
vi.mock("../workspace/cache", () => ({
  getWorkspaceForAgent: vi.fn(),
}));

import { callConvex } from "../convex/client";
import { callWorker } from "../worker/client";
import { getWorkspaceForAgent } from "../workspace/cache";
import { registerSubmitSolution } from "./submitSolution";
import { runWithAuth } from "../lib/context";

const mockCallConvex = vi.mocked(callConvex);
const mockCallWorker = vi.mocked(callWorker);
const mockGetWorkspaceForAgent = vi.mocked(getWorkspaceForAgent);
import { AuthenticatedUser } from "../lib/types";

function createMockServer() {
  const tools: Record<string, { handler: Function }> = {};
  return {
    tool: (_name: string, _description: string, _schema: unknown, handler: Function) => {
      tools[_name] = { handler };
    },
    tools,
  };
}

const testUser: AuthenticatedUser = {
  userId: "user_abc123",
  name: "Test Agent",
  email: "agent@test.com",
  role: "agent",
  scopes: ["bounties:read", "submissions:write"],
};

describe("submit_solution tool", () => {
  let mockServer: ReturnType<typeof createMockServer>;
  let handler: Function;

  beforeEach(() => {
    vi.clearAllMocks();
    mockServer = createMockServer();
    registerSubmitSolution(mockServer as any);
    handler = mockServer.tools["submit_solution"].handler;
  });

  it("successful submission with diff", async () => {
    mockGetWorkspaceForAgent.mockResolvedValueOnce({
      found: true,
      workspaceId: "ws_123",
      workerHost: "https://worker.example.com",
      status: "ready",
      expiresAt: Date.now() + 3600_000,
    });

    mockCallWorker.mockResolvedValueOnce({
      diffPatch: "diff --git a/file.ts b/file.ts\n+new line",
      diffStat: " file.ts | 1 +\n 1 file changed, 1 insertion(+)",
      changedFiles: ["file.ts"],
      hasChanges: true,
    });

    mockCallConvex.mockResolvedValueOnce({
      submissionId: "sub_1",
      verificationId: "ver_1",
    });

    const result = await runWithAuth(testUser, () =>
      handler({ bountyId: "bounty_1", description: "Fixed the bug" }, {}),
    );

    // Verify workspace lookup used auth-resolved agentId
    expect(mockGetWorkspaceForAgent).toHaveBeenCalledWith("user_abc123", "bounty_1");

    // Verify diff was extracted from the workspace
    expect(mockCallWorker).toHaveBeenCalledWith(
      "https://worker.example.com",
      "/api/workspace/diff",
      { workspaceId: "ws_123" },
    );

    // Verify submission was created via Convex
    expect(mockCallConvex).toHaveBeenCalledWith(
      "/api/mcp/submissions/create-from-workspace",
      {
        bountyId: "bounty_1",
        agentId: "user_abc123",
        workspaceId: "ws_123",
        diffPatch: "diff --git a/file.ts b/file.ts\n+new line",
        description: "Fixed the bug",
      },
    );

    // Verify success result
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Solution Submitted");
    expect(result.content[0].text).toContain("sub_1");
    expect(result.content[0].text).toContain("ver_1");
  });

  it("rejects when workspace not found", async () => {
    mockGetWorkspaceForAgent.mockResolvedValueOnce({
      found: false,
      workspaceId: "",
      workerHost: "",
      status: "",
      expiresAt: 0,
    });

    const result = await runWithAuth(testUser, () =>
      handler({ bountyId: "bounty_1" }, {}),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("No workspace found");
    expect(result.content[0].text).toContain("claim_bounty");
    // callWorker should not have been called
    expect(mockCallWorker).not.toHaveBeenCalled();
    expect(mockCallConvex).not.toHaveBeenCalled();
  });

  it("rejects when workspace is not ready", async () => {
    mockGetWorkspaceForAgent.mockResolvedValueOnce({
      found: true,
      workspaceId: "ws_123",
      workerHost: "https://worker.example.com",
      status: "provisioning",
      expiresAt: Date.now() + 3600_000,
    });

    const result = await runWithAuth(testUser, () =>
      handler({ bountyId: "bounty_1" }, {}),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Workspace is not ready");
    expect(result.content[0].text).toContain("provisioning");
    expect(mockCallWorker).not.toHaveBeenCalled();
  });

  it("rejects when no changes detected", async () => {
    mockGetWorkspaceForAgent.mockResolvedValueOnce({
      found: true,
      workspaceId: "ws_123",
      workerHost: "https://worker.example.com",
      status: "ready",
      expiresAt: Date.now() + 3600_000,
    });

    mockCallWorker.mockResolvedValueOnce({
      diffPatch: "",
      diffStat: "",
      changedFiles: [],
      hasChanges: false,
    });

    const result = await runWithAuth(testUser, () =>
      handler({ bountyId: "bounty_1" }, {}),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("No changes detected");
    // callConvex should not have been called since there are no changes
    expect(mockCallConvex).not.toHaveBeenCalled();
  });

  it("returns isError when no auth context", async () => {
    // Call without runWithAuth so getAuthUser() returns undefined
    const result = await handler({ bountyId: "bounty_1" }, {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Authentication required");
  });
});
