import { query, mutation, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { getCurrentUser, requireAuth, requireBountyAccess } from "./lib/utils";
import { Doc } from "./_generated/dataModel";

/**
 * Redact step definition source code for non-creator callers.
 * Non-creators receive public Gherkin only and never see hidden scenarios or
 * step definition source code.
 *
 * The `relationship` parameter reflects the caller's relationship to the
 * specific bounty (creator/admin/agent), NOT a global account role.
 */
function redactForNonCreator(
  test: Doc<"generatedTests">,
  relationship: "creator" | "admin" | "agent"
) {
  if (relationship !== "creator" && relationship !== "admin") {
    const {
      stepDefinitions: _stepDefs,
      stepDefinitionsPublic: _stepDefsPub,
      stepDefinitionsHidden: _stepDefsHid,
      nativeTestFilesPublic: _nativePub,
      nativeTestFilesHidden: _nativeHid,
      gherkinHidden: _gherkinHidden,
      llmModel: _model,
      ...safe
    } = test;
    return {
      ...safe,
      gherkinHidden: "[hidden scenarios redacted]",
    };
  }
  return test;
}

export const getByBountyId = query({
  args: { bountyId: v.id("bounties") },
  handler: async (ctx, args) => {
    const { role } = await requireBountyAccess(ctx, args.bountyId, { allowAgent: true });

    const test = await ctx.db
      .query("generatedTests")
      .withIndex("by_bountyId", (q) => q.eq("bountyId", args.bountyId))
      .order("desc")
      .first();

    if (!test) return null;
    return redactForNonCreator(test, role);
  },
});

export const getByConversationId = query({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) throw new Error("Conversation not found");

    const { role } = await requireBountyAccess(ctx, conversation.bountyId, { allowAgent: true });

    const test = await ctx.db
      .query("generatedTests")
      .withIndex("by_conversationId", (q) =>
        q.eq("conversationId", args.conversationId)
      )
      .order("desc")
      .first();

    if (!test) return null;
    return redactForNonCreator(test, role);
  },
});

export const listByBounty = query({
  args: { bountyId: v.id("bounties") },
  handler: async (ctx, args) => {
    const { role } = await requireBountyAccess(ctx, args.bountyId, { allowAgent: true });

    const tests = await ctx.db
      .query("generatedTests")
      .withIndex("by_bountyId", (q) => q.eq("bountyId", args.bountyId))
      .collect();

    return tests.map((t) => redactForNonCreator(t, role));
  },
});

export const getByConversationIdInternal = internalQuery({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("generatedTests")
      .withIndex("by_conversationId", (q) =>
        q.eq("conversationId", args.conversationId)
      )
      .order("desc")
      .first();
  },
});

export const getByBountyIdInternal = internalQuery({
  args: { bountyId: v.id("bounties") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("generatedTests")
      .withIndex("by_bountyId", (q) => q.eq("bountyId", args.bountyId))
      .order("desc")
      .first();
  },
});

/** Internal mutation to update Gherkin on an existing record (upsert support for retry) */
export const updateGherkinInternal = internalMutation({
  args: {
    generatedTestId: v.id("generatedTests"),
    gherkinPublic: v.string(),
    gherkinHidden: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.generatedTestId, {
      gherkinPublic: args.gherkinPublic,
      gherkinHidden: args.gherkinHidden,
      stepDefinitions: "", // Reset for re-generation
      stepDefinitionsPublic: undefined,
      stepDefinitionsHidden: undefined,
      nativeTestFilesPublic: undefined,
      nativeTestFilesHidden: undefined,
      status: "draft",
      nativeTestsStale: true,
    });
  },
});

export const create = internalMutation({
  args: {
    bountyId: v.id("bounties"),
    conversationId: v.id("conversations"),
    gherkinPublic: v.string(),
    gherkinHidden: v.string(),
    stepDefinitions: v.string(),
    testFramework: v.string(),
    testLanguage: v.string(),
    llmModel: v.string(),
  },
  handler: async (ctx, args) => {
    // Get current max version
    const existing = await ctx.db
      .query("generatedTests")
      .withIndex("by_bountyId", (q) => q.eq("bountyId", args.bountyId))
      .collect();
    const maxVersion = existing.reduce((max, t) => Math.max(max, t.version), 0);

    return await ctx.db.insert("generatedTests", {
      bountyId: args.bountyId,
      conversationId: args.conversationId,
      version: maxVersion + 1,
      gherkinPublic: args.gherkinPublic,
      gherkinHidden: args.gherkinHidden,
      stepDefinitions: args.stepDefinitions,
      nativeTestFilesPublic: undefined,
      nativeTestFilesHidden: undefined,
      testFramework: args.testFramework,
      testLanguage: args.testLanguage,
      status: "draft",
      llmModel: args.llmModel,
      nativeTestsStale: true,
    });
  },
});

export const updateStepDefinitions = internalMutation({
  args: {
    generatedTestId: v.id("generatedTests"),
    stepDefinitions: v.string(),
    stepDefinitionsPublic: v.optional(v.string()),
    stepDefinitionsHidden: v.optional(v.string()),
    testFramework: v.string(),
    testLanguage: v.string(),
  },
  handler: async (ctx, args) => {
    const updates: Record<string, unknown> = {
      stepDefinitions: args.stepDefinitions,
      nativeTestFilesPublic: args.stepDefinitionsPublic,
      nativeTestFilesHidden: args.stepDefinitionsHidden,
      testFramework: args.testFramework,
      testLanguage: args.testLanguage,
      nativeTestsStale: false,
      lastValidatedAt: Date.now(),
    };
    if (args.stepDefinitionsPublic !== undefined) {
      updates.stepDefinitionsPublic = args.stepDefinitionsPublic;
    }
    if (args.stepDefinitionsHidden !== undefined) {
      updates.stepDefinitionsHidden = args.stepDefinitionsHidden;
    }
    await ctx.db.patch(args.generatedTestId, updates);
  },
});

export const updateStatus = internalMutation({
  args: {
    generatedTestId: v.id("generatedTests"),
    status: v.union(
      v.literal("draft"),
      v.literal("approved"),
      v.literal("published")
    ),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.generatedTestId, { status: args.status });
  },
});

export const approve = mutation({
  args: {
    generatedTestId: v.id("generatedTests"),
  },
  handler: async (ctx, args) => {
    const user = requireAuth(await getCurrentUser(ctx));

    const test = await ctx.db.get(args.generatedTestId);
    if (!test) throw new Error("Generated test not found");

    const bounty = await ctx.db.get(test.bountyId);
    if (!bounty) throw new Error("Bounty not found");
    if (bounty.creatorId !== user._id && user.role !== "admin") {
      throw new Error("Unauthorized");
    }

    if (test.nativeTestsStale) {
      throw new Error("Native test files are stale. Regenerate or update them before approval.");
    }

    await ctx.db.patch(args.generatedTestId, { status: "approved" });
  },
});

export const publish = mutation({
  args: {
    generatedTestId: v.id("generatedTests"),
  },
  handler: async (ctx, args) => {
    const user = requireAuth(await getCurrentUser(ctx));

    const test = await ctx.db.get(args.generatedTestId);
    if (!test) throw new Error("Generated test not found");

    const bounty = await ctx.db.get(test.bountyId);
    if (!bounty) throw new Error("Bounty not found");
    if (bounty.creatorId !== user._id && user.role !== "admin") {
      throw new Error("Unauthorized");
    }

    // All users must approve tests before publishing
    if (test.status !== "approved") {
      throw new Error("Please approve tests before publishing");
    }

    await ctx.db.patch(args.generatedTestId, { status: "published" });
  },
});

export const updateGherkin = mutation({
  args: {
    generatedTestId: v.id("generatedTests"),
    gherkinPublic: v.optional(v.string()),
    gherkinHidden: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = requireAuth(await getCurrentUser(ctx));

    const test = await ctx.db.get(args.generatedTestId);
    if (!test) throw new Error("Generated test not found");

    const bounty = await ctx.db.get(test.bountyId);
    if (!bounty) throw new Error("Bounty not found");
    if (bounty.creatorId !== user._id && user.role !== "admin") {
      throw new Error("Unauthorized");
    }

    // SECURITY: Freeze tests once an agent has claimed the bounty
    if (bounty.status !== "draft" && bounty.status !== "active") {
      throw new Error(
        "Tests cannot be modified after an agent has claimed the bounty"
      );
    }

    const updates: Record<string, unknown> = {};
    if (args.gherkinPublic !== undefined) updates.gherkinPublic = args.gherkinPublic;
    if (args.gherkinHidden !== undefined) updates.gherkinHidden = args.gherkinHidden;
    if (args.gherkinPublic !== undefined || args.gherkinHidden !== undefined) {
      updates.nativeTestsStale = true;
      updates.status = "draft";
    }

    await ctx.db.patch(args.generatedTestId, updates);
  },
});

export const updateStepDefinitionsPublic = mutation({
  args: {
    generatedTestId: v.id("generatedTests"),
    stepDefinitions: v.string(),
  },
  handler: async (ctx, args) => {
    const user = requireAuth(await getCurrentUser(ctx));

    const test = await ctx.db.get(args.generatedTestId);
    if (!test) throw new Error("Generated test not found");

    const bounty = await ctx.db.get(test.bountyId);
    if (!bounty) throw new Error("Bounty not found");
    if (bounty.creatorId !== user._id && user.role !== "admin") {
      throw new Error("Unauthorized");
    }

    // SECURITY: Freeze tests once an agent has claimed the bounty
    if (bounty.status !== "draft" && bounty.status !== "active") {
      throw new Error(
        "Tests cannot be modified after an agent has claimed the bounty"
      );
    }

    await ctx.db.patch(args.generatedTestId, {
      stepDefinitions: args.stepDefinitions,
      nativeTestFilesPublic: args.stepDefinitions,
      stepDefinitionsPublic: args.stepDefinitions,
      nativeTestsStale: false,
    });
  },
});

export const updateNativeTestFiles = mutation({
  args: {
    generatedTestId: v.id("generatedTests"),
    nativeTestFilesPublic: v.optional(v.string()),
    nativeTestFilesHidden: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = requireAuth(await getCurrentUser(ctx));

    const test = await ctx.db.get(args.generatedTestId);
    if (!test) throw new Error("Generated test not found");

    const bounty = await ctx.db.get(test.bountyId);
    if (!bounty) throw new Error("Bounty not found");
    if (bounty.creatorId !== user._id && user.role !== "admin") {
      throw new Error("Unauthorized");
    }

    if (bounty.status !== "draft" && bounty.status !== "active") {
      throw new Error("Tests cannot be modified after an agent has claimed the bounty");
    }

    const updates: Record<string, unknown> = {
      status: "draft",
      nativeTestsStale: false,
    };
    if (args.nativeTestFilesPublic !== undefined) {
      updates.nativeTestFilesPublic = args.nativeTestFilesPublic;
      updates.stepDefinitionsPublic = args.nativeTestFilesPublic;
      updates.stepDefinitions = args.nativeTestFilesPublic;
    }
    if (args.nativeTestFilesHidden !== undefined) {
      updates.nativeTestFilesHidden = args.nativeTestFilesHidden;
      updates.stepDefinitionsHidden = args.nativeTestFilesHidden;
    }

    await ctx.db.patch(args.generatedTestId, updates);
  },
});

export const updateNativeTestFilesInternal = internalMutation({
  args: {
    generatedTestId: v.id("generatedTests"),
    nativeTestFilesPublic: v.optional(v.string()),
    nativeTestFilesHidden: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const test = await ctx.db.get(args.generatedTestId);
    if (!test) throw new Error("Generated test not found");

    const bounty = await ctx.db.get(test.bountyId);
    if (!bounty) throw new Error("Bounty not found");
    if (bounty.status !== "draft" && bounty.status !== "active") {
      throw new Error("Tests cannot be modified after an agent has claimed the bounty");
    }

    const updates: Record<string, unknown> = {
      status: "draft",
      nativeTestsStale: false,
    };
    if (args.nativeTestFilesPublic !== undefined) {
      updates.nativeTestFilesPublic = args.nativeTestFilesPublic;
      updates.stepDefinitionsPublic = args.nativeTestFilesPublic;
    }
    if (args.nativeTestFilesHidden !== undefined) {
      updates.nativeTestFilesHidden = args.nativeTestFilesHidden;
      updates.stepDefinitionsHidden = args.nativeTestFilesHidden;
    }
    if (
      args.nativeTestFilesPublic !== undefined ||
      args.nativeTestFilesHidden !== undefined
    ) {
      const publicPayload = args.nativeTestFilesPublic ?? test.nativeTestFilesPublic ?? "";
      const hiddenPayload = args.nativeTestFilesHidden ?? test.nativeTestFilesHidden ?? "";
      updates.stepDefinitions = [publicPayload, hiddenPayload].filter(Boolean).join("\n\n");
    }

    await ctx.db.patch(args.generatedTestId, updates);
  },
});
