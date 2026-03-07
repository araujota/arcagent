import { query, mutation, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { getCurrentUser, requireAuth } from "./lib/utils";
import { internal } from "./_generated/api";
import { MIN_TIER_ELIGIBLE_REWARD, SAME_CREATOR_30D_LIMIT } from "./lib/tierCalculation";

const ratingDimension = v.number(); // 1-5

function validateDimension(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1 || value > 5) {
    throw new Error(`${name} must be an integer between 1 and 5`);
  }
}

export const submitRating = mutation({
  args: {
    bountyId: v.id("bounties"),
    codeQuality: ratingDimension,
    speed: ratingDimension,
    mergedWithoutChanges: ratingDimension,
    communication: ratingDimension,
    testCoverage: ratingDimension,
    comment: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = requireAuth(await getCurrentUser(ctx));

    // Validate dimensions
    validateDimension(args.codeQuality, "codeQuality");
    validateDimension(args.speed, "speed");
    validateDimension(args.mergedWithoutChanges, "mergedWithoutChanges");
    validateDimension(args.communication, "communication");
    validateDimension(args.testCoverage, "testCoverage");

    const bounty = await ctx.db.get(args.bountyId);
    if (!bounty) throw new Error("Bounty not found");

    // Must be the bounty creator
    if (bounty.creatorId !== user._id) {
      throw new Error("Only the bounty creator can rate the agent");
    }

    // Bounty must be completed
    if (bounty.status !== "completed") {
      throw new Error("Can only rate agents on completed bounties");
    }

    // No duplicate rating
    const existingRating = await ctx.db
      .query("agentRatings")
      .withIndex("by_bountyId", (q) => q.eq("bountyId", args.bountyId))
      .first();
    if (existingRating) {
      throw new Error("A rating already exists for this bounty");
    }

    // Find the completing submission to get the agent ID
    const completedClaim = await ctx.db
      .query("bountyClaims")
      .withIndex("by_bountyId", (q) => q.eq("bountyId", args.bountyId))
      .filter((q) => q.eq(q.field("status"), "completed"))
      .first();
    if (!completedClaim) {
      throw new Error("No completed claim found for this bounty");
    }

    const agentId = completedClaim.agentId;

    // SECURITY: Anti-sybil — creator cannot be the same user as agent
    if (bounty.creatorId === agentId) {
      throw new Error("Cannot rate yourself");
    }

    // Determine tier eligibility
    let tierEligible = bounty.reward >= MIN_TIER_ELIGIBLE_REWARD;

    // Same-creator throttle: max 3 bounties from same creator in 30-day window
    if (tierEligible) {
      const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const recentRatingsFromCreator = await ctx.db
        .query("agentRatings")
        .withIndex("by_agentId_and_createdAt", (q) =>
          q.eq("agentId", agentId).gte("createdAt", thirtyDaysAgo)
        )
        .filter((q) => q.eq(q.field("creatorId"), user._id))
        .collect();

      if (recentRatingsFromCreator.length >= SAME_CREATOR_30D_LIMIT) {
        tierEligible = false;
      }
    }

    const ratingId = await ctx.db.insert("agentRatings", {
      bountyId: args.bountyId,
      agentId,
      creatorId: user._id,
      codeQuality: args.codeQuality,
      speed: args.speed,
      mergedWithoutChanges: args.mergedWithoutChanges,
      communication: args.communication,
      testCoverage: args.testCoverage,
      comment: args.comment,
      tierEligible,
      createdAt: Date.now(),
    });

    // Schedule stats recomputation
    await ctx.scheduler.runAfter(0, internal.agentStats.recomputeForAgent, {
      agentId,
    });
    await ctx.scheduler.runAfter(0, internal.agentStats.recomputeTierForAgent, {
      agentId,
    });

    // Record activity feed event
    await ctx.scheduler.runAfter(0, internal.activityFeed.record, {
      type: "agent_rated",
      bountyId: args.bountyId,
      bountyTitle: bounty.title,
      actorName: user.name,
    });

    return ratingId;
  },
});

export const submitRatingFromMcp = internalMutation({
  args: {
    bountyId: v.id("bounties"),
    creatorId: v.id("users"),
    codeQuality: ratingDimension,
    speed: ratingDimension,
    mergedWithoutChanges: ratingDimension,
    communication: ratingDimension,
    testCoverage: ratingDimension,
    comment: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Validate dimensions
    validateDimension(args.codeQuality, "codeQuality");
    validateDimension(args.speed, "speed");
    validateDimension(args.mergedWithoutChanges, "mergedWithoutChanges");
    validateDimension(args.communication, "communication");
    validateDimension(args.testCoverage, "testCoverage");

    const bounty = await ctx.db.get(args.bountyId);
    if (!bounty) throw new Error("Bounty not found");

    if (bounty.creatorId !== args.creatorId) {
      throw new Error("Only the bounty creator can rate the agent");
    }

    if (bounty.status !== "completed") {
      throw new Error("Can only rate agents on completed bounties");
    }

    const existingRating = await ctx.db
      .query("agentRatings")
      .withIndex("by_bountyId", (q) => q.eq("bountyId", args.bountyId))
      .first();
    if (existingRating) {
      throw new Error("A rating already exists for this bounty");
    }

    const completedClaim = await ctx.db
      .query("bountyClaims")
      .withIndex("by_bountyId", (q) => q.eq("bountyId", args.bountyId))
      .filter((q) => q.eq(q.field("status"), "completed"))
      .first();
    if (!completedClaim) {
      throw new Error("No completed claim found for this bounty");
    }

    const agentId = completedClaim.agentId;

    if (bounty.creatorId === agentId) {
      throw new Error("Cannot rate yourself");
    }

    let tierEligible = bounty.reward >= MIN_TIER_ELIGIBLE_REWARD;

    if (tierEligible) {
      const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
      const recentRatingsFromCreator = await ctx.db
        .query("agentRatings")
        .withIndex("by_agentId_and_createdAt", (q) =>
          q.eq("agentId", agentId).gte("createdAt", thirtyDaysAgo)
        )
        .filter((q) => q.eq(q.field("creatorId"), args.creatorId))
        .collect();

      if (recentRatingsFromCreator.length >= SAME_CREATOR_30D_LIMIT) {
        tierEligible = false;
      }
    }

    const creator = await ctx.db.get(args.creatorId);

    const ratingId = await ctx.db.insert("agentRatings", {
      bountyId: args.bountyId,
      agentId,
      creatorId: args.creatorId,
      codeQuality: args.codeQuality,
      speed: args.speed,
      mergedWithoutChanges: args.mergedWithoutChanges,
      communication: args.communication,
      testCoverage: args.testCoverage,
      comment: args.comment,
      tierEligible,
      createdAt: Date.now(),
    });

    await ctx.scheduler.runAfter(0, internal.agentStats.recomputeForAgent, {
      agentId,
    });
    await ctx.scheduler.runAfter(0, internal.agentStats.recomputeTierForAgent, {
      agentId,
    });

    await ctx.scheduler.runAfter(0, internal.activityFeed.record, {
      type: "agent_rated",
      bountyId: args.bountyId,
      bountyTitle: bounty.title,
      actorName: creator?.name ?? "A creator",
    });

    return ratingId;
  },
});

export const getByBounty = query({
  args: { bountyId: v.id("bounties") },
  handler: async (ctx, args) => {
    const user = requireAuth(await getCurrentUser(ctx));

    const rating = await ctx.db
      .query("agentRatings")
      .withIndex("by_bountyId", (q) => q.eq("bountyId", args.bountyId))
      .first();

    if (!rating) return null;

    // Visible to creator and rated agent
    if (rating.creatorId !== user._id && rating.agentId !== user._id && user.role !== "admin") {
      return null;
    }

    return rating;
  },
});

export const getByBountyInternal = internalQuery({
  args: { bountyId: v.id("bounties") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("agentRatings")
      .withIndex("by_bountyId", (q) => q.eq("bountyId", args.bountyId))
      .first();
  },
});

export const listByAgent = query({
  args: { agentId: v.id("users") },
  handler: async (ctx, args) => {
    const user = requireAuth(await getCurrentUser(ctx));

    const ratings = await ctx.db
      .query("agentRatings")
      .withIndex("by_agentId", (q) => q.eq("agentId", args.agentId))
      .collect();

    // Full dimensions visible to the agent and rating creators; composite visible publicly
    const isAgent = user._id === args.agentId;
    const isAdmin = user.role === "admin";

    return ratings.map((r) => {
      const isRater = r.creatorId === user._id;
      if (isAgent || isRater || isAdmin) {
        return r;
      }
      // Public view: only composite rating
      const avg =
        (r.codeQuality + r.speed + r.mergedWithoutChanges + r.communication + r.testCoverage) / 5;
      return {
        _id: r._id,
        _creationTime: r._creationTime,
        bountyId: r.bountyId,
        agentId: r.agentId,
        creatorId: r.creatorId,
        averageRating: avg,
        createdAt: r.createdAt,
      };
    });
  },
});

export const listByAgentInternal = internalQuery({
  args: { agentId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("agentRatings")
      .withIndex("by_agentId", (q) => q.eq("agentId", args.agentId))
      .collect();
  },
});
