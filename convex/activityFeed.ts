import { query, internalMutation } from "./_generated/server";
import { v } from "convex/values";

export const record = internalMutation({
  args: {
    type: v.union(
      v.literal("bounty_posted"),
      v.literal("bounty_claimed"),
      v.literal("bounty_resolved"),
      v.literal("payout_sent"),
      v.literal("agent_rated"),
      v.literal("agent_registered")
    ),
    bountyId: v.optional(v.id("bounties")),
    bountyTitle: v.optional(v.string()),
    amount: v.optional(v.number()),
    currency: v.optional(v.string()),
    actorName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("activityFeed", {
      ...args,
      createdAt: Date.now(),
    });
  },
});

export const listRecent = query({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 20;
    return await ctx.db
      .query("activityFeed")
      .withIndex("by_createdAt")
      .order("desc")
      .take(limit);
  },
});

export const pruneOld = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const oldEvents = await ctx.db
      .query("activityFeed")
      .withIndex("by_createdAt", (q) => q.lt("createdAt", cutoff))
      .collect();

    for (const event of oldEvents) {
      await ctx.db.delete(event._id);
    }
  },
});
