import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../convex/client", () => ({ callConvex: vi.fn() }));
vi.mock("../worker/client", () => ({ callWorker: vi.fn() }));

import { callConvex } from "../convex/client";
import { registerGetBountyDetails } from "./getBountyDetails";
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

describe("get_bounty_details tool", () => {
  let handler: Function;

  beforeEach(() => {
    vi.clearAllMocks();
    const server = createMockServer();
    registerGetBountyDetails(server as any);
    handler = server.tools["get_bounty_details"].handler;
  });

  it("returns full details with test suites and repo map", async () => {
    mockCallConvex.mockResolvedValue({
      bounty: {
        _id: "b1",
        title: "Fix login",
        description: "Login is broken",
        status: "active",
        reward: 100,
        rewardCurrency: "USD",
        claimDurationHours: 4,
        isClaimed: false,
        creator: { name: "Alice" },
        tags: ["react", "typescript"],
        deadline: 1700000000000,
        testSuites: [
          { title: "Login Suite", version: 1, gherkinContent: "Feature: Login\n  Scenario: Valid login\n    Given a user", visibility: "public" },
          { title: "Security Suite", version: 1, gherkinContent: "Feature: Security\n  Scenario: SQL injection", visibility: "hidden" },
        ],
        repoMap: { repoMapText: "src/\n  index.ts\n  login.ts" },
        testFramework: "vitest",
        testLanguage: "typescript",
      },
    });

    const result = await runWithAuth(testUser, () =>
      handler({ bountyId: "b1" }),
    );

    const text = result.content[0].text;
    expect(text).toContain("Fix login");
    expect(text).toContain("Alice");
    expect(text).toContain("Public Tests");
    expect(text).toContain("Hidden Tests");
    expect(text).toContain("Repository Structure");
    expect(text).toContain("vitest");
  });

  it("scope enforcement -> requires bounties:read", async () => {
    const noScopeUser: AuthenticatedUser = { ...testUser, scopes: [] };
    await expect(
      runWithAuth(noScopeUser, () => handler({ bountyId: "b1" })),
    ).rejects.toThrow();
  });

  it("minimal bounty (no suites, no repo)", async () => {
    mockCallConvex.mockResolvedValue({
      bounty: {
        _id: "b2",
        title: "Simple task",
        description: "Do something simple",
        status: "active",
        reward: 50,
        rewardCurrency: "USD",
        claimDurationHours: 2,
        isClaimed: false,
        creator: null,
        tags: [],
        testSuites: [],
        repoMap: null,
      },
    });

    const result = await runWithAuth(testUser, () =>
      handler({ bountyId: "b2" }),
    );

    const text = result.content[0].text;
    expect(text).toContain("Simple task");
    expect(text).not.toContain("Public Tests");
    expect(text).not.toContain("Repository Structure");
  });

  it("shows claim status correctly", async () => {
    mockCallConvex.mockResolvedValue({
      bounty: {
        _id: "b3",
        title: "Claimed bounty",
        description: "Already claimed",
        status: "in_progress",
        reward: 100,
        rewardCurrency: "USD",
        claimDurationHours: 4,
        isClaimed: true,
        creator: null,
        tags: [],
        testSuites: [],
        repoMap: null,
      },
    });

    const result = await runWithAuth(testUser, () =>
      handler({ bountyId: "b3" }),
    );

    expect(result.content[0].text).toContain("locked by another agent");
  });
});
