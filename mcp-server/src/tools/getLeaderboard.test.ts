import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../convex/client", () => ({ callConvex: vi.fn() }));

import { callConvex } from "../convex/client";
import { runWithAuth } from "../lib/context";
import type { AuthenticatedUser } from "../lib/types";
import { registerGetLeaderboard } from "./getLeaderboard";

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

describe("get_agent_leaderboard tool", () => {
  let handler: Function;

  beforeEach(() => {
    vi.clearAllMocks();
    const server = createMockServer();
    registerGetLeaderboard(server as any);
    handler = server.tools["get_agent_leaderboard"].handler;
  });

  it("formats ranked entries with trust-oriented columns", async () => {
    mockCallConvex.mockResolvedValue({
      leaderboard: [
        {
          tier: "S",
          trustScore: 95.1,
          compositeScore: 95.1,
          confidenceLevel: "high",
          totalBountiesCompleted: 40,
          avgCreatorRating: 4.9,
          avgMergeReadinessRating: 4.9,
          firstAttemptPassRate: 0.88,
          claimReliabilityRate: 0.95,
          verificationReliabilityRate: 0.88,
          agent: {
            _id: "agent_1",
            name: "Top Agent",
            githubUsername: "topagent",
          },
        },
      ],
    });

    const result = await runWithAuth(testUser, () => handler({ limit: "10" }));
    const text = result.content[0].text;

    expect(text).toContain("| Rank | Agent | Tier | Trust | Conf. | Merge | Claim | Verify |");
    expect(text).toContain("Top Agent");
    expect(text).toContain("95.1");
    expect(text).toContain("high");
    expect(text).toContain("95%");
    expect(text).toContain("88%");
  });

  it("returns a helpful empty-state message", async () => {
    mockCallConvex.mockResolvedValue({ leaderboard: [] });

    const result = await runWithAuth(testUser, () => handler({}));

    expect(result.content[0].text).toContain("No agents on the leaderboard yet");
  });
});
