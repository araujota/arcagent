import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../convex/client", () => ({ callConvex: vi.fn() }));
vi.mock("../worker/client", () => ({ callWorker: vi.fn() }));

import { callConvex } from "../convex/client";
import { registerGetBountyGenerationStatus } from "./getBountyGenerationStatus";
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

describe("get_bounty_generation_status tool", () => {
  let handler: Function;

  beforeEach(() => {
    vi.clearAllMocks();
    const server = createMockServer();
    registerGetBountyGenerationStatus(server as any);
    handler = server.tools["get_bounty_generation_status"].handler;
  });

  it("full status ready -> 'Overall Ready: YES'", async () => {
    mockCallConvex.mockResolvedValue({
      repoIndexing: { status: "ready", totalFiles: 42, languages: ["typescript"] },
      conversation: { status: "finalized", autonomous: false, messageCount: 10 },
      requirementsDraft: { status: "approved", version: 2, acceptanceCriteriaCount: 5, openQuestionsCount: 0 },
      generatedTest: { status: "published", version: 1, testFramework: "vitest", testLanguage: "typescript", nativeTestsStale: false },
      testSuitesCount: 3,
      creationStage: "done",
      nextAction: "fund_or_publish",
      publishReady: true,
      overallReady: true,
    });

    const result = await runWithAuth(testUser, () =>
      handler({ bountyId: "b1" }),
    );

    expect(result.content[0].text).toContain("Overall Ready: YES");
    expect(result.content[0].text).toContain("Requirements Draft");
    expect(result.content[0].text).toContain("42");
    expect(result.content[0].text).toContain("vitest");
  });

  it("partial status -> 'Overall Ready: NO'", async () => {
    mockCallConvex.mockResolvedValue({
      repoIndexing: { status: "indexing", totalFiles: 10 },
      conversation: null,
      requirementsDraft: null,
      generatedTest: null,
      testSuitesCount: 0,
      creationStage: "requirements",
      nextAction: "wait_for_repo_indexing",
      publishReady: false,
      overallReady: false,
    });

    const result = await runWithAuth(testUser, () =>
      handler({ bountyId: "b1" }),
    );

    expect(result.content[0].text).toContain("Overall Ready: NO");
    expect(result.content[0].text).toContain("Next Action: wait_for_repo_indexing");
    expect(result.content[0].text).toContain("Poll again");
  });

  it("error -> isError: true", async () => {
    mockCallConvex.mockRejectedValue(new Error("Bounty not found"));

    const result = await runWithAuth(testUser, () =>
      handler({ bountyId: "nonexistent" }),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Bounty not found");
  });
});
