import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

export const consume = internalMutation({
  args: {
    nonce: v.string(),
    verificationId: v.id("verifications"),
    ttlMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("workerCallbackNonces")
      .withIndex("by_nonce", (q) => q.eq("nonce", args.nonce))
      .first();

    if (existing) {
      return { accepted: false as const };
    }

    const now = Date.now();
    const ttlMs = Math.max(60_000, Math.min(args.ttlMs ?? 10 * 60 * 1000, 24 * 60 * 60 * 1000));

    await ctx.db.insert("workerCallbackNonces", {
      nonce: args.nonce,
      verificationId: args.verificationId,
      createdAt: now,
      expiresAt: now + ttlMs,
    });

    return { accepted: true as const };
  },
});

export const pruneExpired = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const expired = await ctx.db
      .query("workerCallbackNonces")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
      .collect();

    for (const row of expired) {
      await ctx.db.delete(row._id);
    }

    return { deleted: expired.length };
  },
});
