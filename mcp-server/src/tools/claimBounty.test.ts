import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../convex/client", () => ({ callConvex: vi.fn() }));
vi.mock("../worker/client", () => ({ callWorker: vi.fn() }));

import { callConvex } from "../convex/client";
import { registerClaimBounty } from "./claimBounty";
import { runWithAuth } from "../lib/context";
import { AuthenticatedUser } from "../lib/types";

const mockCallConvex = vi.mocked(callConvex);

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
  scopes: ["bounties:read", "bounties:claim"],
};

describe("claim_bounty tool", () => {
  let mockServer: ReturnType<typeof createMockServer>;
  let handler: Function;

  beforeEach(() => {
    vi.clearAllMocks();
    mockServer = createMockServer();
    registerClaimBounty(mockServer as any);
    handler = mockServer.tools["claim_bounty"].handler;
  });

  it("calls callConvex correctly and returns success message", async () => {
    mockCallConvex
      .mockResolvedValueOnce({
        bounty: {
          _id: "bounty_1",
          title: "Fix login bug",
          description: "Description",
          status: "active",
          reward: 100,
          rewardCurrency: "USD",
          claimDurationHours: 4,
          creator: null,
          testSuites: [],
          repoMap: null,
          isClaimed: false,
        },
      })
      .mockResolvedValueOnce({
        claimId: "claim_1",
        repoInfo: null,
      });

    const result = await runWithAuth(testUser, () =>
      handler({ bountyId: "bounty_1" }, {}),
    );

    // Verify callConvex was called for bounty details
    expect(mockCallConvex).toHaveBeenCalledWith("/api/mcp/bounties/get", {
      bountyId: "bounty_1",
    });

    // Verify callConvex was called for claim creation with auth-resolved agentId
    expect(mockCallConvex).toHaveBeenCalledWith("/api/mcp/claims/create", {
      bountyId: "bounty_1",
      agentId: "user_abc123",
    });

    // Verify success result
    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toContain("Bounty Claimed Successfully");
    expect(result.content[0].text).toContain("claim_1");
    expect(result.content[0].text).toContain("Fix login bug");
  });

  it("returns isError when Convex claim fails", async () => {
    mockCallConvex
      .mockResolvedValueOnce({
        bounty: {
          _id: "bounty_1",
          title: "Fix login bug",
          description: "Description",
          status: "active",
          reward: 100,
          rewardCurrency: "USD",
          claimDurationHours: 4,
          creator: null,
          testSuites: [],
          repoMap: null,
          isClaimed: false,
        },
      })
      .mockRejectedValueOnce(new Error("Bounty already claimed by another agent"));

    const result = await runWithAuth(testUser, () =>
      handler({ bountyId: "bounty_1" }, {}),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Failed to claim bounty");
    expect(result.content[0].text).toContain("Bounty already claimed by another agent");
  });

  it("throws when no auth context", async () => {
    await expect(handler({ bountyId: "bounty_1" }, {})).rejects.toThrow(
      'Authentication required: cannot verify required "bounties:claim" scope',
    );
  });
});
