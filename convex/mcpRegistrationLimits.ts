import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

export const consume = internalMutation({
  args: {
    key: v.string(),
    maxRequests: v.number(),
    windowMs: v.number(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const windowStartMs = Math.floor(now / args.windowMs) * args.windowMs;

    const existing = await ctx.db
      .query("mcpRegistrationLimits")
      .withIndex("by_key_and_windowStartMs", (q) =>
        q.eq("key", args.key).eq("windowStartMs", windowStartMs))
      .unique();

    if (!existing) {
      await ctx.db.insert("mcpRegistrationLimits", {
        key: args.key,
        windowStartMs,
        count: 1,
        expiresAt: windowStartMs + args.windowMs,
        updatedAt: now,
      });
      return { allowed: true, retryAfterMs: 0 };
    }

    if (existing.count >= args.maxRequests) {
      return {
        allowed: false,
        retryAfterMs: Math.max(0, existing.expiresAt - now),
      };
    }

    await ctx.db.patch(existing._id, {
      count: existing.count + 1,
      updatedAt: now,
    });

    return { allowed: true, retryAfterMs: 0 };
  },
});
