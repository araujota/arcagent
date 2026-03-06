import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../convex/client", () => ({ callConvex: vi.fn() }));
vi.mock("../worker/client", () => ({ callWorker: vi.fn() }));

import { callConvex } from "../convex/client";
import { registerGetBountyGenerationDraft } from "./getBountyGenerationDraft";
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
  userId: "user_creator",
  name: "Creator",
  email: "creator@test.com",
  role: "creator",
  scopes: ["bounties:read", "bounties:create"],
};

describe("get_bounty_generation_draft tool", () => {
  let handler: Function;

  beforeEach(() => {
    vi.clearAllMocks();
    const server = createMockServer();
    registerGetBountyGenerationDraft(server as any);
    handler = server.tools["get_bounty_generation_draft"].handler;
  });

  it("renders requirements and generated tests", async () => {
    mockCallConvex.mockResolvedValue({
      bounty: {
        id: "b1",
        title: "Improve staged flow",
        creationStage: "tests",
        commercialConfigPending: true,
      },
      requirementsDraft: {
        id: "gr1",
        status: "draft",
        version: 2,
        requirementsMarkdown: "## Summary\nGrounded requirements",
        acceptanceCriteria: [{ id: "ER-AC-01", text: "Criterion" }],
        openQuestions: ["Question"],
        citationsJson: null,
        reviewScoreJson: null,
        editedAt: null,
        approvedAt: null,
      },
      testsDraft: {
        id: "gt1",
        status: "draft",
        version: 1,
        gherkinPublic: "Feature: Public",
        gherkinHidden: "Feature: Hidden",
        nativeTestFilesPublic: null,
        nativeTestFilesHidden: null,
        nativeTestsStale: true,
        testFramework: "vitest",
        testLanguage: "typescript",
        lastValidatedAt: null,
      },
    });

    const result = await runWithAuth(testUser, () => handler({ bountyId: "b1" }));

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Requirements Draft");
    expect(result.content[0].text).toContain("Grounded requirements");
    expect(result.content[0].text).toContain("Generated Tests");
  });
});
