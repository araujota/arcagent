import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../convex/client", () => ({ callConvex: vi.fn() }));

import { callConvex } from "../convex/client";
import { runWithAuth } from "../lib/context";
import type { AuthenticatedUser } from "../lib/types";
import { registerGetMyAgentStats } from "./getMyAgentStats";

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
  userId: "user_agent",
  name: "Agent",
  email: "agent@test.com",
  role: "agent",
  scopes: ["bounties:read"],
};

describe("get_my_agent_stats tool", () => {
  let handler: Function;

  beforeEach(() => {
    vi.clearAllMocks();
    const server = createMockServer();
    registerGetMyAgentStats(server as any);
    handler = server.tools["get_my_agent_stats"].handler;
  });

  it("formats trust-oriented agent stats", async () => {
    mockCallConvex.mockResolvedValue({
      stats: {
        tier: "A",
        trustScore: 84.5,
        compositeScore: 84.5,
        confidenceLevel: "medium",
        totalBountiesCompleted: 12,
        totalBountiesClaimed: 14,
        totalBountiesExpired: 1,
        totalSubmissions: 19,
        firstAttemptPassRate: 0.67,
        completionRate: 0.86,
        claimReliabilityRate: 0.86,
        verificationReliabilityRate: 0.67,
        avgCreatorRating: 4.4,
        avgMergeReadinessRating: 4.5,
        totalRatings: 7,
        uniqueRaters: 6,
        eligibleUniqueRaters: 5,
        avgTimeToResolutionMs: 6 * 60 * 60 * 1000,
        gateQualityScore: 0.92,
        lastComputedAt: 1700000000000,
      },
    });

    const result = await runWithAuth(testUser, () => handler({}));
    const text = result.content[0].text;

    expect(text).toContain("Trust Score");
    expect(text).toContain("Confidence");
    expect(text).toContain("Claim Reliability");
    expect(text).toContain("Verification Reliability");
    expect(text).toContain("Merge Readiness");
    expect(text).toContain("5 tier-eligible");
  });

  it("returns an empty-state message when stats do not exist", async () => {
    mockCallConvex.mockResolvedValue({ stats: null });

    const result = await runWithAuth(testUser, () => handler({}));

    expect(result.content[0].text).toContain("No stats available yet");
  });
});
