import { query, mutation, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { getCurrentUser, requireAuth, requireRole } from "./lib/utils";

export const getByBountyId = query({
  args: { bountyId: v.id("bounties") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("generatedTests")
      .withIndex("by_bountyId", (q) => q.eq("bountyId", args.bountyId))
      .order("desc")
      .first();
  },
});

export const getByConversationId = query({
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

export const listByBounty = query({
  args: { bountyId: v.id("bounties") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("generatedTests")
      .withIndex("by_bountyId", (q) => q.eq("bountyId", args.bountyId))
      .collect();
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
      testFramework: args.testFramework,
      testLanguage: args.testLanguage,
      status: "draft",
      llmModel: args.llmModel,
    });
  },
});

export const updateStepDefinitions = internalMutation({
  args: {
    generatedTestId: v.id("generatedTests"),
    stepDefinitions: v.string(),
    testFramework: v.string(),
    testLanguage: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.generatedTestId, {
      stepDefinitions: args.stepDefinitions,
      testFramework: args.testFramework,
      testLanguage: args.testLanguage,
    });
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
    requireRole(user, ["creator", "admin"]);

    const test = await ctx.db.get(args.generatedTestId);
    if (!test) throw new Error("Generated test not found");

    const bounty = await ctx.db.get(test.bountyId);
    if (!bounty) throw new Error("Bounty not found");
    if (bounty.creatorId !== user._id && user.role !== "admin") {
      throw new Error("Unauthorized");
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
    requireRole(user, ["creator", "admin"]);

    const test = await ctx.db.get(args.generatedTestId);
    if (!test) throw new Error("Generated test not found");

    const bounty = await ctx.db.get(test.bountyId);
    if (!bounty) throw new Error("Bounty not found");
    if (bounty.creatorId !== user._id && user.role !== "admin") {
      throw new Error("Unauthorized");
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
    requireRole(user, ["creator", "admin"]);

    const test = await ctx.db.get(args.generatedTestId);
    if (!test) throw new Error("Generated test not found");

    const bounty = await ctx.db.get(test.bountyId);
    if (!bounty) throw new Error("Bounty not found");
    if (bounty.creatorId !== user._id && user.role !== "admin") {
      throw new Error("Unauthorized");
    }

    const updates: Record<string, unknown> = {};
    if (args.gherkinPublic !== undefined) updates.gherkinPublic = args.gherkinPublic;
    if (args.gherkinHidden !== undefined) updates.gherkinHidden = args.gherkinHidden;

    await ctx.db.patch(args.generatedTestId, updates);
  },
});
