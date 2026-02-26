import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../convex/client", () => ({ callConvex: vi.fn() }));

import { callConvex } from "../convex/client";
import { registerTestBounty } from "./testBounty";
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
  scopes: ["bounties:create", "bounties:claim"],
};

describe("testbounty tool", () => {
  let handler: Function;

  beforeEach(() => {
    vi.clearAllMocks();
    const server = createMockServer();
    registerTestBounty(server as any);
    handler = server.tools.testbounty.handler;
  });

  it("creates and returns instructions", async () => {
    mockCallConvex.mockResolvedValue({
      bountyId: "b123",
      claimId: "c123",
      repositoryUrl: "https://github.com/araujota/arcagent",
      commitSha: "abcdef1234567",
      testBountyKind: "agenthello_v1",
      message: "ok",
    });

    const result = await runWithAuth(testUser, () => handler({}));

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Test Bounty Ready");
    expect(result.content[0].text).toContain("b123");
    expect(mockCallConvex).toHaveBeenCalledWith("/api/mcp/testbounty/create", {
      agentId: "agent_123",
    });
  });

  it("returns error when convex call fails", async () => {
    mockCallConvex.mockRejectedValue(new Error("boom"));

    const result = await runWithAuth(testUser, () => handler({}));

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("boom");
  });

  it("throws when auth context is missing", async () => {
    await expect(handler({})).rejects.toThrow("Authentication required");
  });
});
