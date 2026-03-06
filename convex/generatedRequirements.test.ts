import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import {
  extractAcceptanceCriteriaFromMarkdown,
  extractOpenQuestionsFromMarkdown,
} from "./generatedRequirements";
import { seedBounty, seedConversation, seedUser } from "./__tests__/helpers";

describe("generatedRequirements helpers", () => {
  it("extracts stable acceptance criteria ids from markdown", () => {
    const markdown = `## Acceptance Criteria
- ER-AC-01: shows saved repos first
- generates enhanced requirements

## Open Questions
- none`;

    expect(extractAcceptanceCriteriaFromMarkdown(markdown)).toEqual([
      { id: "ER-AC-01", text: "shows saved repos first" },
      { id: "ER-AC-02", text: "generates enhanced requirements" },
    ]);
    expect(extractOpenQuestionsFromMarkdown(markdown)).toEqual(["none"]);
  });
});

describe("generatedRequirements lifecycle", () => {
  it("creates a draft and approves it into the bounty description", async () => {
    const t = convexTest(schema);
    const { bountyId, conversationId } = await t.run(async (ctx) => {
      const creatorId = await seedUser(ctx);
      const bountyId = await seedBounty(ctx, creatorId, {
        status: "draft",
        creationStage: "requirements",
      });
      const conversationId = await seedConversation(ctx, bountyId, {
        status: "requirements_review",
      });
      return { bountyId, conversationId };
    });

    const requirementId = await t.mutation(internal.generatedRequirements.createOrReplaceDraft, {
      bountyId,
      conversationId,
      sourceTitle: "Improve staged bounty creation",
      sourceBrief: "Raw ticket brief",
      requirementsMarkdown: `## Summary
hello

## Acceptance Criteria
- ER-AC-01: first criterion

## Open Questions
- question one`,
      acceptanceCriteria: [{ id: "ER-AC-01", text: "first criterion" }],
      openQuestions: ["question one"],
      citationsJson: JSON.stringify({ staleAfterEdit: false }),
      reviewScoreJson: JSON.stringify({ scores: { outputs: 3 } }),
      llmProvider: "anthropic",
      llmModel: "claude-sonnet",
    });

    await t.mutation(internal.generatedRequirements.approveInternal, {
      generatedRequirementId: requirementId,
    });

    const state = await t.run(async (ctx) => {
      return {
        generatedRequirement: await ctx.db.get(requirementId),
        bounty: await ctx.db.get(bountyId),
      };
    });

    expect(state.generatedRequirement?.status).toBe("approved");
    expect(state.generatedRequirement?.approvedAt).toBeTypeOf("number");
    expect(state.bounty?.description).toContain("## Summary");
    expect(state.bounty?.creationStage).toBe("tests");
  });
});
