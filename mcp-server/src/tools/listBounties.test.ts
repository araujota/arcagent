import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../convex/client", () => ({ callConvex: vi.fn() }));
vi.mock("../worker/client", () => ({ callWorker: vi.fn() }));

import { callConvex } from "../convex/client";
import { registerListBounties } from "./listBounties";
import { runWithAuth } from "../lib/context";
import { AuthenticatedUser } from "../lib/types";

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

describe("list_bounties tool", () => {
  let handler: Function;

  beforeEach(() => {
    vi.clearAllMocks();
    const server = createMockServer();
    registerListBounties(server as any);
    handler = server.tools["list_bounties"].handler;
  });

  it("returns formatted list from mock data", async () => {
    mockCallConvex.mockResolvedValue({
      bounties: [
        { _id: "b1", title: "Fix bug", reward: 100, rewardCurrency: "USD", status: "active", tags: ["react"] },
        { _id: "b2", title: "Add feature", reward: 200, rewardCurrency: "USD", status: "active", tags: [] },
      ],
    });

    const result = await runWithAuth(testUser, () =>
      handler({}),
    );

    expect(result.content[0].text).toContain("2 bounties");
    expect(result.content[0].text).toContain("Fix bug");
    expect(result.content[0].text).toContain("Add feature");
  });

  it("empty result -> 'No bounties found'", async () => {
    mockCallConvex.mockResolvedValue({ bounties: [] });

    const result = await runWithAuth(testUser, () =>
      handler({}),
    );

    expect(result.content[0].text).toContain("No bounties found");
  });

  it("limit capping -> Math.min(limit, 100)", async () => {
    mockCallConvex.mockResolvedValue({ bounties: [] });

    await runWithAuth(testUser, () =>
      handler({ limit: "200" }),
    );

    expect(mockCallConvex).toHaveBeenCalledWith(
      "/api/mcp/bounties/list",
      expect.objectContaining({ limit: 100 }),
    );
  });

  it("scope enforcement -> requires bounties:read", async () => {
    const noScopeUser: AuthenticatedUser = {
      ...testUser,
      scopes: [], // no scopes
    };

    await expect(
      runWithAuth(noScopeUser, () => handler({})),
    ).rejects.toThrow();
  });

  it("passes status and search filters through", async () => {
    mockCallConvex.mockResolvedValue({ bounties: [] });

    await runWithAuth(testUser, () =>
      handler({ status: "completed", search: "login", minReward: "175" }),
    );

    expect(mockCallConvex).toHaveBeenCalledWith(
      "/api/mcp/bounties/list",
      expect.objectContaining({ status: "completed", search: "login", minReward: 175 }),
    );
  });
});
