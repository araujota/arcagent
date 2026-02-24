import { query, internalMutation } from "./_generated/server";
import { v } from "convex/values";

export const listByVerification = query({
  args: { verificationId: v.id("verifications") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("sanityGates")
      .withIndex("by_verificationId", (q) =>
        q.eq("verificationId", args.verificationId)
      )
      .collect();
  },
});

export const record = internalMutation({
  args: {
    verificationId: v.id("verifications"),
    gateType: v.union(
      v.literal("lint"),
      v.literal("typecheck"),
      v.literal("security"),
      v.literal("build"),
      v.literal("sonarqube"),
      v.literal("snyk"),
      v.literal("memory")
    ),
    tool: v.string(),
    status: v.union(
      v.literal("passed"),
      v.literal("failed"),
      v.literal("warning")
    ),
    issues: v.optional(v.array(v.string())),
    detailsJson: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("sanityGates", args);
  },
});
