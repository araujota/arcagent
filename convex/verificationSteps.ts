import { query, internalMutation } from "./_generated/server";
import { v } from "convex/values";

export const listByVerification = query({
  args: { verificationId: v.id("verifications") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("verificationSteps")
      .withIndex("by_verificationId", (q) =>
        q.eq("verificationId", args.verificationId)
      )
      .collect();
  },
});

export const createInternal = internalMutation({
  args: {
    steps: v.array(
      v.object({
        verificationId: v.id("verifications"),
        scenarioName: v.string(),
        featureName: v.string(),
        status: v.union(
          v.literal("pass"),
          v.literal("fail"),
          v.literal("skip"),
          v.literal("error")
        ),
        executionTimeMs: v.number(),
        output: v.optional(v.string()),
        stepNumber: v.number(),
        visibility: v.optional(v.union(v.literal("public"), v.literal("hidden"))),
      })
    ),
  },
  handler: async (ctx, args) => {
    for (const step of args.steps) {
      await ctx.db.insert("verificationSteps", step);
    }
  },
});

export const record = internalMutation({
  args: {
    verificationId: v.id("verifications"),
    scenarioName: v.string(),
    featureName: v.string(),
    status: v.union(
      v.literal("pass"),
      v.literal("fail"),
      v.literal("skip"),
      v.literal("error")
    ),
    executionTimeMs: v.number(),
    output: v.optional(v.string()),
    stepNumber: v.number(),
    visibility: v.optional(v.union(v.literal("public"), v.literal("hidden"))),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("verificationSteps", args);
  },
});
