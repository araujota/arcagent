import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../convex/client", () => ({ callConvex: vi.fn() }));

import { callConvex } from "../convex/client";
import { runWithAuth } from "../lib/context";
import type { AuthenticatedUser } from "../lib/types";
import { registerGetAgentProfile } from "./getAgentProfile";

const mockCallConvex = vi.mocked(callConvex);

function createMockServer() {
  const tools: Record<string, { handler: Function }> = {};
  return {
    tool: (_name: string, _desc: string, _schema: unknown, handler: Function) => {
      tools[_name] = { handler };
    },
    tools,
  };
}

const testUser: AuthenticatedUser = {
  userId: "user_creator",
  name: "Creator",
  email: "creator@test.com",
  role: "creator",
  scopes: ["bounties:read"],
};

describe("get_agent_profile tool", () => {
  let handler: Function;

  beforeEach(() => {
    vi.clearAllMocks();
    const server = createMockServer();
    registerGetAgentProfile(server as any);
    handler = server.tools["get_agent_profile"].handler;
  });

  it("formats a public profile with trust and reliability fields", async () => {
    mockCallConvex.mockResolvedValue({
      stats: {
        tier: "S",
        trustScore: 93.2,
        compositeScore: 93.2,
        confidenceLevel: "high",
        totalBountiesCompleted: 31,
        totalBountiesClaimed: 34,
        firstAttemptPassRate: 0.84,
        completionRate: 0.91,
        claimReliabilityRate: 0.91,
        verificationReliabilityRate: 0.84,
        avgCreatorRating: 4.8,
        avgMergeReadinessRating: 4.9,
        totalRatings: 18,
        uniqueRaters: 11,
        eligibleUniqueRaters: 9,
        avgTimeToResolutionMs: 4 * 60 * 60 * 1000,
        gateQualityScore: 0.97,
        agent: {
          name: "Top Agent",
          githubUsername: "topagent",
        },
      },
    });

    const result = await runWithAuth(testUser, () => handler({ agentId: "agent_123" }));
    const text = result.content[0].text;

    expect(text).toContain("Top Agent");
    expect(text).toContain("Trust Score");
    expect(text).toContain("Confidence");
    expect(text).toContain("Claim Reliability");
    expect(text).toContain("Verification Reliability");
    expect(text).toContain("9 tier-eligible");
  });
});
