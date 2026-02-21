import { convexTest } from "convex-test";
import { describe, it, expect } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import { seedUser, seedBounty, seedConversation, seedGeneratedTest } from "./__tests__/helpers";

describe("generatedTests.create", () => {
  it("auto-increments version (first v1, second v2)", async () => {
    const t = convexTest(schema);
    const { bountyId, conversationId } = await t.run(async (ctx) => {
      const creatorId = await seedUser(ctx);
      const bountyId = await seedBounty(ctx, creatorId);
      const conversationId = await seedConversation(ctx, bountyId);
      return { bountyId, conversationId };
    });

    const id1 = await t.mutation(internal.generatedTests.create, {
      bountyId,
      conversationId,
      gherkinPublic: "Feature: v1",
      gherkinHidden: "Feature: v1 hidden",
      stepDefinitions: "// steps",
      testFramework: "vitest",
      testLanguage: "typescript",
      llmModel: "claude-3",
    });

    const id2 = await t.mutation(internal.generatedTests.create, {
      bountyId,
      conversationId,
      gherkinPublic: "Feature: v2",
      gherkinHidden: "Feature: v2 hidden",
      stepDefinitions: "// steps v2",
      testFramework: "vitest",
      testLanguage: "typescript",
      llmModel: "claude-3",
    });

    const test1 = await t.run(async (ctx) => ctx.db.get(id1));
    const test2 = await t.run(async (ctx) => ctx.db.get(id2));
    expect(test1!.version).toBe(1);
    expect(test2!.version).toBe(2);
  });
});

describe("generatedTests.getByBountyIdInternal (no redaction)", () => {
  it("returns full record with stepDefinitions and llmModel", async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const creatorId = await seedUser(ctx);
      const bountyId = await seedBounty(ctx, creatorId);
      const convId = await seedConversation(ctx, bountyId);
      await seedGeneratedTest(ctx, bountyId, convId, {
        stepDefinitions: "secret-steps",
        llmModel: "claude-3-opus",
      });
    });

    // Use internal query which skips redaction
    const bountyId = await t.run(async (ctx) => {
      const bounties = await ctx.db.query("bounties").collect();
      return bounties[0]!._id;
    });

    const test = await t.query(internal.generatedTests.getByBountyIdInternal, { bountyId });
    expect(test).toBeDefined();
    expect(test!.stepDefinitions).toBe("secret-steps");
    expect(test!.llmModel).toBe("claude-3-opus");
  });
});

describe("generatedTests.updateGherkinInternal", () => {
  it("updates gherkin and resets status to draft", async () => {
    const t = convexTest(schema);
    const testId = await t.run(async (ctx) => {
      const creatorId = await seedUser(ctx);
      const bountyId = await seedBounty(ctx, creatorId);
      const convId = await seedConversation(ctx, bountyId);
      return await seedGeneratedTest(ctx, bountyId, convId, { status: "approved" });
    });

    await t.mutation(internal.generatedTests.updateGherkinInternal, {
      generatedTestId: testId,
      gherkinPublic: "Feature: Updated Public",
      gherkinHidden: "Feature: Updated Hidden",
    });

    const test = await t.run(async (ctx) => ctx.db.get(testId));
    expect(test!.gherkinPublic).toBe("Feature: Updated Public");
    expect(test!.gherkinHidden).toBe("Feature: Updated Hidden");
    expect(test!.status).toBe("draft");
  });
});

describe("generatedTests.updateStatus", () => {
  it("updates status to approved", async () => {
    const t = convexTest(schema);
    const testId = await t.run(async (ctx) => {
      const creatorId = await seedUser(ctx);
      const bountyId = await seedBounty(ctx, creatorId);
      const convId = await seedConversation(ctx, bountyId);
      return await seedGeneratedTest(ctx, bountyId, convId);
    });

    await t.mutation(internal.generatedTests.updateStatus, {
      generatedTestId: testId,
      status: "approved",
    });

    const test = await t.run(async (ctx) => ctx.db.get(testId));
    expect(test!.status).toBe("approved");
  });
});

describe("generatedTests.updateStepDefinitions", () => {
  it("updates step definitions and test framework", async () => {
    const t = convexTest(schema);
    const testId = await t.run(async (ctx) => {
      const creatorId = await seedUser(ctx);
      const bountyId = await seedBounty(ctx, creatorId);
      const convId = await seedConversation(ctx, bountyId);
      return await seedGeneratedTest(ctx, bountyId, convId);
    });

    await t.mutation(internal.generatedTests.updateStepDefinitions, {
      generatedTestId: testId,
      stepDefinitions: "new-steps",
      stepDefinitionsPublic: "public-steps",
      stepDefinitionsHidden: "hidden-steps",
      testFramework: "jest",
      testLanguage: "javascript",
    });

    const test = await t.run(async (ctx) => ctx.db.get(testId));
    expect(test!.stepDefinitions).toBe("new-steps");
    expect(test!.stepDefinitionsPublic).toBe("public-steps");
    expect(test!.stepDefinitionsHidden).toBe("hidden-steps");
    expect(test!.testFramework).toBe("jest");
    expect(test!.testLanguage).toBe("javascript");
  });
});
