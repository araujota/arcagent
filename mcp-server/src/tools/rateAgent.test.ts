import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../convex/client", () => ({ callConvex: vi.fn() }));

import { callConvex } from "../convex/client";
import { registerRateAgent } from "./rateAgent";
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

const creatorUser: AuthenticatedUser = {
  userId: "user_creator_1",
  name: "Creator",
  email: "creator@test.com",
  role: "creator",
  scopes: ["bounties:create", "bounties:read"],
};

describe("rate_agent tool", () => {
  let server: ReturnType<typeof createMockServer>;
  let handler: Function;

  beforeEach(() => {
    vi.clearAllMocks();
    server = createMockServer();
    registerRateAgent(server as any);
    handler = server.tools["rate_agent"].handler;
  });

  it("binds rating submit identity to auth context and does not send creatorId", async () => {
    mockCallConvex.mockResolvedValue({ ratingId: "rating_1" });

    const result = await runWithAuth(creatorUser, () =>
      handler({
        bountyId: "bounty_1",
        codeQuality: "5",
        speed: "4",
        mergedWithoutChanges: "4",
        communication: "5",
        testCoverage: "5",
      }),
    );

    expect(result.isError).toBeUndefined();
    expect(mockCallConvex).toHaveBeenCalledWith(
      "/api/mcp/ratings/submit",
      expect.objectContaining({
        bountyId: "bounty_1",
        codeQuality: 5,
        speed: 4,
        mergedWithoutChanges: 4,
        communication: 5,
        testCoverage: 5,
      }),
    );
    expect(mockCallConvex).toHaveBeenCalledWith(
      "/api/mcp/ratings/submit",
      expect.not.objectContaining({ creatorId: expect.anything() }),
    );
  });

  it("rejects invalid rating dimensions", async () => {
    const result = await runWithAuth(creatorUser, () =>
      handler({
        bountyId: "bounty_1",
        codeQuality: "9",
        speed: "4",
        mergedWithoutChanges: "4",
        communication: "5",
        testCoverage: "5",
      }),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Invalid codeQuality");
    expect(mockCallConvex).not.toHaveBeenCalled();
  });

  it("returns auth error outside authenticated context", async () => {
    await expect(
      handler({
        bountyId: "bounty_1",
        codeQuality: "5",
        speed: "5",
        mergedWithoutChanges: "5",
        communication: "5",
        testCoverage: "5",
      }),
    ).rejects.toThrow("Authentication required");
    expect(mockCallConvex).not.toHaveBeenCalled();
  });
});
