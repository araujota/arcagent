import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../convex/client", () => ({ callConvex: vi.fn() }));
vi.mock("../worker/client", () => ({ callWorker: vi.fn() }));

import { callConvex } from "../convex/client";
import { registerCreateBounty } from "./createBounty";
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
  userId: "user_creator",
  name: "Creator",
  email: "creator@test.com",
  role: "creator",
  scopes: ["bounties:create", "bounties:read"],
};

const defaultArgs = {
  title: "Fix login bug",
  description: "The login form crashes on submit",
  reward: "100",
  rewardCurrency: "USD",
  paymentMethod: "stripe" as const,
  tosAccepted: true,
};

describe("create_bounty tool", () => {
  let handler: Function;

  beforeEach(() => {
    vi.clearAllMocks();
    const server = createMockServer();
    registerCreateBounty(server as any);
    handler = server.tools["create_bounty"].handler;
  });

  it("success with repo URL -> output contains staged generation messaging", async () => {
    mockCallConvex.mockResolvedValue({
      bountyId: "b1",
      repoConnectionId: "rc1",
      conversationId: "conv1",
    });

    const result = await runWithAuth(testUser, () =>
      handler({ ...defaultArgs, repositoryUrl: "https://github.com/owner/repo" }),
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Staged Generation Started");
    expect(result.content[0].text).toContain("rc1");
  });

  it("success without repo URL -> 'No repository URL provided'", async () => {
    mockCallConvex.mockResolvedValue({
      bountyId: "b2",
      repoConnectionId: null,
      conversationId: null,
    });

    const result = await runWithAuth(testUser, () =>
      handler(defaultArgs),
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("No repository URL provided");
  });

  it("no auth -> throws authentication error", async () => {
    await expect(handler(defaultArgs)).rejects.toThrow("Authentication required");
  });

  it("TOS not accepted -> TOS error", async () => {
    const result = await runWithAuth(testUser, () =>
      handler({ ...defaultArgs, tosAccepted: false }),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Terms of Service");
  });

  it("C1: callConvex receives creatorId from auth context, not args", async () => {
    mockCallConvex.mockResolvedValue({
      bountyId: "b3",
      repoConnectionId: null,
      conversationId: null,
    });

    await runWithAuth(testUser, () => handler(defaultArgs));

    expect(mockCallConvex).toHaveBeenCalledWith(
      "/api/mcp/bounties/create",
      expect.objectContaining({ creatorId: "user_creator" }),
    );
  });

  it("error propagation -> isError: true", async () => {
    mockCallConvex.mockRejectedValue(new Error("Duplicate title"));

    const result = await runWithAuth(testUser, () =>
      handler(defaultArgs),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Duplicate title");
  });

  it("includes PM issue info when provided", async () => {
    mockCallConvex.mockResolvedValue({
      bountyId: "b4",
      repoConnectionId: null,
      conversationId: null,
    });

    const result = await runWithAuth(testUser, () =>
      handler({ ...defaultArgs, pmIssueKey: "PROJ-123", pmProvider: "jira" }),
    );

    expect(result.content[0].text).toContain("jira/PROJ-123");
  });
});
