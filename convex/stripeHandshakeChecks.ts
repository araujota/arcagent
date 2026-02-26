import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";

export const record = internalMutation({
  args: {
    bountyId: v.id("bounties"),
    agentId: v.id("users"),
    verificationId: v.id("verifications"),
    status: v.union(v.literal("passed"), v.literal("failed")),
    connectAccountId: v.optional(v.string()),
    payoutsEnabled: v.optional(v.boolean()),
    chargesEnabled: v.optional(v.boolean()),
    currentlyDueCount: v.optional(v.number()),
    ready: v.boolean(),
    message: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("stripeHandshakeChecks", {
      ...args,
      checkedAt: Date.now(),
    });
  },
});

export const getLatestByVerification = internalQuery({
  args: {
    verificationId: v.id("verifications"),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("stripeHandshakeChecks")
      .withIndex("by_verificationId", (q) => q.eq("verificationId", args.verificationId))
      .order("desc")
      .first();
  },
});
