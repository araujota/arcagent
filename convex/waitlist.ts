import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const join = mutation({
  args: {
    email: v.string(),
    source: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const email = args.email.trim().toLowerCase();

    if (!EMAIL_REGEX.test(email)) {
      throw new Error("Invalid email address");
    }

    const existing = await ctx.db
      .query("waitlist")
      .withIndex("by_email", (q) => q.eq("email", email))
      .first();

    if (existing) {
      return { status: "duplicate" as const };
    }

    await ctx.db.insert("waitlist", {
      email,
      source: args.source,
      joinedAt: Date.now(),
    });

    return { status: "success" as const };
  },
});

export const count = query({
  args: {},
  handler: async (ctx) => {
    const entries = await ctx.db.query("waitlist").collect();
    return entries.length;
  },
});
