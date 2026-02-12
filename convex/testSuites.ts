import { query, mutation, internalQuery, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { getCurrentUser, requireAuth, requireRole, requireBountyAccess } from "./lib/utils";

export const listByBounty = query({
  args: {
    bountyId: v.id("bounties"),
    visibility: v.optional(
      v.union(v.literal("public"), v.literal("hidden"))
    ),
  },
  handler: async (ctx, args) => {
    if (args.visibility) {
      return await ctx.db
        .query("testSuites")
        .withIndex("by_bountyId_and_visibility", (q) =>
          q.eq("bountyId", args.bountyId).eq("visibility", args.visibility!)
        )
        .collect();
    }

    // Only show hidden tests to the bounty creator or admin
    const user = await getCurrentUser(ctx);
    const bounty = await ctx.db.get(args.bountyId);

    const allSuites = await ctx.db
      .query("testSuites")
      .withIndex("by_bountyId", (q) => q.eq("bountyId", args.bountyId))
      .collect();

    if (user && bounty && (bounty.creatorId === user._id || user.role === "admin")) {
      return allSuites;
    }

    return allSuites.filter((s) => s.visibility === "public");
  },
});

export const listAllByBounty = internalQuery({
  args: { bountyId: v.id("bounties") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("testSuites")
      .withIndex("by_bountyId", (q) => q.eq("bountyId", args.bountyId))
      .collect();
  },
});

export const getById = query({
  args: { testSuiteId: v.id("testSuites") },
  handler: async (ctx, args) => {
    const suite = await ctx.db.get(args.testSuiteId);
    if (!suite) return null;

    const { role } = await requireBountyAccess(ctx, suite.bountyId, { allowAgent: true });

    // Block agents from viewing hidden test suites
    if (role === "agent" && suite.visibility === "hidden") {
      throw new Error("Unauthorized");
    }

    return suite;
  },
});

export const createInternal = internalMutation({
  args: {
    bountyId: v.id("bounties"),
    title: v.string(),
    gherkinContent: v.string(),
    visibility: v.union(v.literal("public"), v.literal("hidden")),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("testSuites")
      .withIndex("by_bountyId", (q) => q.eq("bountyId", args.bountyId))
      .collect();
    const maxVersion = existing.reduce((max, s) => Math.max(max, s.version), 0);

    return await ctx.db.insert("testSuites", {
      bountyId: args.bountyId,
      title: args.title,
      version: maxVersion + 1,
      gherkinContent: args.gherkinContent,
      visibility: args.visibility,
    });
  },
});

export const create = mutation({
  args: {
    bountyId: v.id("bounties"),
    title: v.string(),
    gherkinContent: v.string(),
    visibility: v.union(v.literal("public"), v.literal("hidden")),
  },
  handler: async (ctx, args) => {
    const user = requireAuth(await getCurrentUser(ctx));
    requireRole(user, ["creator", "admin"]);

    const bounty = await ctx.db.get(args.bountyId);
    if (!bounty) throw new Error("Bounty not found");
    if (bounty.creatorId !== user._id && user.role !== "admin") {
      throw new Error("Unauthorized");
    }

    // Get current max version
    const existing = await ctx.db
      .query("testSuites")
      .withIndex("by_bountyId", (q) => q.eq("bountyId", args.bountyId))
      .collect();
    const maxVersion = existing.reduce((max, s) => Math.max(max, s.version), 0);

    return await ctx.db.insert("testSuites", {
      bountyId: args.bountyId,
      title: args.title,
      version: maxVersion + 1,
      gherkinContent: args.gherkinContent,
      visibility: args.visibility,
    });
  },
});

export const update = mutation({
  args: {
    testSuiteId: v.id("testSuites"),
    title: v.optional(v.string()),
    gherkinContent: v.optional(v.string()),
    visibility: v.optional(
      v.union(v.literal("public"), v.literal("hidden"))
    ),
  },
  handler: async (ctx, args) => {
    const user = requireAuth(await getCurrentUser(ctx));
    const suite = await ctx.db.get(args.testSuiteId);
    if (!suite) throw new Error("Test suite not found");

    const bounty = await ctx.db.get(suite.bountyId);
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
    if (args.title !== undefined) updates.title = args.title;
    if (args.gherkinContent !== undefined)
      updates.gherkinContent = args.gherkinContent;
    if (args.visibility !== undefined) updates.visibility = args.visibility;

    await ctx.db.patch(args.testSuiteId, updates);
    return args.testSuiteId;
  },
});
