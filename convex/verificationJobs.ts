import { query, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";

export const getByVerificationId = query({
  args: { verificationId: v.id("verifications") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("verificationJobs")
      .withIndex("by_verificationId", (q) =>
        q.eq("verificationId", args.verificationId)
      )
      .first();
  },
});

export const listByStatus = query({
  args: {
    status: v.union(
      v.literal("queued"),
      v.literal("provisioning"),
      v.literal("running"),
      v.literal("teardown"),
      v.literal("completed"),
      v.literal("failed"),
      v.literal("timeout")
    ),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("verificationJobs")
      .withIndex("by_status", (q) => q.eq("status", args.status))
      .collect();
  },
});

export const create = internalMutation({
  args: {
    verificationId: v.id("verifications"),
    bountyId: v.id("bounties"),
    submissionId: v.id("submissions"),
    workerHostUsed: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("verificationJobs", {
      verificationId: args.verificationId,
      bountyId: args.bountyId,
      submissionId: args.submissionId,
      workerHostUsed: args.workerHostUsed,
      status: "queued",
      queuedAt: Date.now(),
    });
  },
});

export const getByVerificationIdInternal = internalQuery({
  args: { verificationId: v.id("verifications") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("verificationJobs")
      .withIndex("by_verificationId", (q) =>
        q.eq("verificationId", args.verificationId)
      )
      .first();
  },
});

export const updateWorkerJobId = internalMutation({
  args: {
    jobId: v.id("verificationJobs"),
    workerJobId: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.jobId, {
      workerJobId: args.workerJobId,
    });
  },
});

export const updateStatus = internalMutation({
  args: {
    jobId: v.id("verificationJobs"),
    status: v.union(
      v.literal("queued"),
      v.literal("provisioning"),
      v.literal("running"),
      v.literal("teardown"),
      v.literal("completed"),
      v.literal("failed"),
      v.literal("timeout")
    ),
    currentGate: v.optional(v.string()),
    vmId: v.optional(v.string()),
    startedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    resourceUsage: v.optional(
      v.object({
        cpuPercent: v.optional(v.number()),
        memoryMb: v.optional(v.number()),
        diskMb: v.optional(v.number()),
      })
    ),
  },
  handler: async (ctx, args) => {
    const { jobId, ...updates } = args;
    const filteredUpdates = Object.fromEntries(
      Object.entries(updates).filter(([, v]) => v !== undefined)
    );
    await ctx.db.patch(jobId, filteredUpdates);
  },
});
