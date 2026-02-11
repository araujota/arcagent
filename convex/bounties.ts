import { query, mutation, action, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { getCurrentUser, requireAuth, requireRole } from "./lib/utils";
import { api } from "./_generated/api";

export const list = query({
  args: {
    status: v.optional(
      v.union(
        v.literal("draft"),
        v.literal("active"),
        v.literal("in_progress"),
        v.literal("completed"),
        v.literal("disputed")
      )
    ),
    paymentMethod: v.optional(
      v.union(v.literal("stripe"), v.literal("web3"))
    ),
    search: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    let bounties;

    if (args.status) {
      bounties = await ctx.db
        .query("bounties")
        .withIndex("by_status", (q) => q.eq("status", args.status!))
        .collect();
    } else {
      bounties = await ctx.db.query("bounties").collect();
    }

    if (args.paymentMethod) {
      bounties = bounties.filter(
        (b) => b.paymentMethod === args.paymentMethod
      );
    }

    if (args.search) {
      const search = args.search.toLowerCase();
      bounties = bounties.filter(
        (b) =>
          b.title.toLowerCase().includes(search) ||
          b.description.toLowerCase().includes(search)
      );
    }

    // Fetch creator info for each bounty
    const bountiesWithCreators = await Promise.all(
      bounties.map(async (bounty) => {
        const creator = await ctx.db.get(bounty.creatorId);
        return { ...bounty, creator };
      })
    );

    return bountiesWithCreators;
  },
});

export const getById = query({
  args: { bountyId: v.id("bounties") },
  handler: async (ctx, args) => {
    const bounty = await ctx.db.get(args.bountyId);
    if (!bounty) return null;

    const creator = await ctx.db.get(bounty.creatorId);
    return { ...bounty, creator };
  },
});

export const listByCreator = query({
  args: {
    status: v.optional(
      v.union(
        v.literal("draft"),
        v.literal("active"),
        v.literal("in_progress"),
        v.literal("completed"),
        v.literal("disputed")
      )
    ),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user) return [];

    if (args.status) {
      return await ctx.db
        .query("bounties")
        .withIndex("by_creatorId_and_status", (q) =>
          q.eq("creatorId", user._id).eq("status", args.status!)
        )
        .collect();
    }

    return await ctx.db
      .query("bounties")
      .withIndex("by_creatorId", (q) => q.eq("creatorId", user._id))
      .collect();
  },
});

export const create = mutation({
  args: {
    title: v.string(),
    description: v.string(),
    reward: v.number(),
    rewardCurrency: v.string(),
    paymentMethod: v.union(v.literal("stripe"), v.literal("web3")),
    deadline: v.optional(v.number()),
    repositoryUrl: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    status: v.optional(
      v.union(v.literal("draft"), v.literal("active"))
    ),
  },
  handler: async (ctx, args) => {
    const user = requireAuth(await getCurrentUser(ctx));
    requireRole(user, ["creator", "admin"]);

    return await ctx.db.insert("bounties", {
      title: args.title,
      description: args.description,
      creatorId: user._id,
      status: args.status ?? "draft",
      reward: args.reward,
      rewardCurrency: args.rewardCurrency,
      paymentMethod: args.paymentMethod,
      deadline: args.deadline,
      repositoryUrl: args.repositoryUrl,
      tags: args.tags,
    });
  },
});

export const update = mutation({
  args: {
    bountyId: v.id("bounties"),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    reward: v.optional(v.number()),
    rewardCurrency: v.optional(v.string()),
    paymentMethod: v.optional(
      v.union(v.literal("stripe"), v.literal("web3"))
    ),
    deadline: v.optional(v.number()),
    repositoryUrl: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const user = requireAuth(await getCurrentUser(ctx));
    const bounty = await ctx.db.get(args.bountyId);
    if (!bounty) throw new Error("Bounty not found");
    if (bounty.creatorId !== user._id && user.role !== "admin") {
      throw new Error("Unauthorized");
    }

    const { bountyId, ...updates } = args;
    const filteredUpdates = Object.fromEntries(
      Object.entries(updates).filter(([, v]) => v !== undefined)
    );

    await ctx.db.patch(bountyId, filteredUpdates);
    return bountyId;
  },
});

export const updateStatus = mutation({
  args: {
    bountyId: v.id("bounties"),
    status: v.union(
      v.literal("draft"),
      v.literal("active"),
      v.literal("in_progress"),
      v.literal("completed"),
      v.literal("disputed")
    ),
  },
  handler: async (ctx, args) => {
    const user = requireAuth(await getCurrentUser(ctx));
    const bounty = await ctx.db.get(args.bountyId);
    if (!bounty) throw new Error("Bounty not found");
    if (bounty.creatorId !== user._id && user.role !== "admin") {
      throw new Error("Unauthorized");
    }

    await ctx.db.patch(args.bountyId, { status: args.status });
    return args.bountyId;
  },
});

export const listForMcp = internalQuery({
  args: {
    status: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    minReward: v.optional(v.number()),
    maxReward: v.optional(v.number()),
    search: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    let bounties;

    if (args.status) {
      bounties = await ctx.db
        .query("bounties")
        .withIndex("by_status", (q) => q.eq("status", args.status as "active"))
        .collect();
    } else {
      // Default to active bounties for MCP
      bounties = await ctx.db
        .query("bounties")
        .withIndex("by_status", (q) => q.eq("status", "active"))
        .collect();
    }

    if (args.minReward !== undefined) {
      bounties = bounties.filter((b) => b.reward >= args.minReward!);
    }
    if (args.maxReward !== undefined) {
      bounties = bounties.filter((b) => b.reward <= args.maxReward!);
    }

    if (args.tags && args.tags.length > 0) {
      bounties = bounties.filter((b) =>
        b.tags?.some((t) => args.tags!.includes(t))
      );
    }

    if (args.search) {
      const search = args.search.toLowerCase();
      bounties = bounties.filter(
        (b) =>
          b.title.toLowerCase().includes(search) ||
          b.description.toLowerCase().includes(search)
      );
    }

    const limit = args.limit ?? 50;
    bounties = bounties.slice(0, limit);

    return bounties.map((b) => ({
      _id: b._id,
      title: b.title,
      description: b.description,
      status: b.status,
      reward: b.reward,
      rewardCurrency: b.rewardCurrency,
      tags: b.tags,
      deadline: b.deadline,
      claimDurationHours: b.claimDurationHours,
    }));
  },
});

export const getForMcp = internalQuery({
  args: { bountyId: v.id("bounties") },
  handler: async (ctx, args) => {
    const bounty = await ctx.db.get(args.bountyId);
    if (!bounty) return null;

    const creator = await ctx.db.get(bounty.creatorId);

    // Get public test suites only
    const testSuites = await ctx.db
      .query("testSuites")
      .withIndex("by_bountyId_and_visibility", (q) =>
        q.eq("bountyId", args.bountyId).eq("visibility", "public")
      )
      .collect();

    // Get repo map
    const repoMap = await ctx.db
      .query("repoMaps")
      .withIndex("by_bountyId", (q) => q.eq("bountyId", args.bountyId))
      .order("desc")
      .first();

    // Get active claim info
    const activeClaim = await ctx.db
      .query("bountyClaims")
      .withIndex("by_bountyId_and_status", (q) =>
        q.eq("bountyId", args.bountyId).eq("status", "active")
      )
      .first();

    return {
      ...bounty,
      creator: creator ? { name: creator.name } : null,
      testSuites: testSuites.map((ts) => ({
        _id: ts._id,
        title: ts.title,
        version: ts.version,
        gherkinContent: ts.gherkinContent,
      })),
      repoMap: repoMap
        ? {
            repoMapText: repoMap.repoMapText,
            symbolTableJson: repoMap.symbolTableJson,
            dependencyGraphJson: repoMap.dependencyGraphJson,
          }
        : null,
      isClaimed: !!activeClaim,
      claimDurationHours: bounty.claimDurationHours ?? 4,
    };
  },
});

/**
 * Connect a repository to a bounty and trigger indexing.
 */
export const connectRepo = action({
  args: {
    bountyId: v.id("bounties"),
    repositoryUrl: v.string(),
  },
  handler: async (ctx, args) => {
    // Create repo connection
    const repoConnectionId = await ctx.runMutation(
      api.repoConnections.create,
      {
        bountyId: args.bountyId,
        repositoryUrl: args.repositoryUrl,
      }
    );

    // Trigger the indexing pipeline
    await ctx.runAction(api.orchestrator.connectAndIndexRepo, {
      bountyId: args.bountyId,
      repoConnectionId,
      repositoryUrl: args.repositoryUrl,
    });

    return repoConnectionId;
  },
});
