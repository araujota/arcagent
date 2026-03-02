import { internalMutation, internalQuery, query } from "./_generated/server";
import { v } from "convex/values";

const RECEIPT_STATUS = v.union(
  v.literal("pass"),
  v.literal("fail"),
  v.literal("error"),
  v.literal("warning"),
  v.literal("unreached"),
  v.literal("skipped_policy"),
);

export const listByVerification = query({
  args: { verificationId: v.id("verifications") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("verificationReceipts")
      .withIndex("by_verificationId_and_orderIndex", (q) =>
        q.eq("verificationId", args.verificationId)
      )
      .collect();
  },
});

export const listByVerificationInternal = internalQuery({
  args: { verificationId: v.id("verifications") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("verificationReceipts")
      .withIndex("by_verificationId_and_orderIndex", (q) =>
        q.eq("verificationId", args.verificationId)
      )
      .collect();
  },
});

export const recordInternal = internalMutation({
  args: {
    verificationId: v.id("verifications"),
    submissionId: v.id("submissions"),
    bountyId: v.id("bounties"),
    agentId: v.optional(v.id("users")),
    claimId: v.optional(v.id("bountyClaims")),
    attemptNumber: v.number(),
    legKey: v.string(),
    orderIndex: v.number(),
    status: RECEIPT_STATUS,
    blocking: v.boolean(),
    unreachedByLegKey: v.optional(v.string()),
    startedAt: v.number(),
    completedAt: v.number(),
    durationMs: v.number(),
    summaryLine: v.string(),
    rawBody: v.optional(v.string()),
    sarifJson: v.optional(v.string()),
    policyJson: v.optional(v.string()),
    metadataJson: v.optional(v.string()),
    createdAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("verificationReceipts")
      .withIndex("by_verificationId_and_orderIndex", (q) =>
        q.eq("verificationId", args.verificationId).eq("orderIndex", args.orderIndex)
      )
      .first();

    const payload = {
      verificationId: args.verificationId,
      submissionId: args.submissionId,
      bountyId: args.bountyId,
      agentId: args.agentId,
      claimId: args.claimId,
      attemptNumber: args.attemptNumber,
      legKey: args.legKey,
      orderIndex: args.orderIndex,
      status: args.status,
      blocking: args.blocking,
      unreachedByLegKey: args.unreachedByLegKey,
      startedAt: args.startedAt,
      completedAt: args.completedAt,
      durationMs: args.durationMs,
      summaryLine: args.summaryLine,
      rawBody: args.rawBody,
      sarifJson: args.sarifJson,
      policyJson: args.policyJson,
      metadataJson: args.metadataJson,
      createdAt: args.createdAt ?? Date.now(),
    };

    if (existing) {
      await ctx.db.patch(existing._id, payload);
      return existing._id;
    }

    return await ctx.db.insert("verificationReceipts", payload);
  },
});
