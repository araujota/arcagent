import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";

export const create = internalMutation({
  args: {
    claimId: v.id("bountyClaims"),
    bountyId: v.id("bounties"),
    agentId: v.id("users"),
    workspaceId: v.string(),
    serviceTokenHash: v.string(),
    tokenSigningKeyId: v.string(),
    mode: v.union(v.literal("shared_worker"), v.literal("dedicated_attempt_vm")),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("attemptWorkers", {
      claimId: args.claimId,
      bountyId: args.bountyId,
      agentId: args.agentId,
      workspaceId: args.workspaceId,
      status: "launching",
      launchRequestedAt: Date.now(),
      serviceTokenHash: args.serviceTokenHash,
      tokenSigningKeyId: args.tokenSigningKeyId,
      mode: args.mode,
    });
  },
});

export const update = internalMutation({
  args: {
    attemptWorkerId: v.id("attemptWorkers"),
    status: v.optional(
      v.union(
        v.literal("launching"),
        v.literal("running"),
        v.literal("healthy"),
        v.literal("ready"),
        v.literal("terminating"),
        v.literal("terminated"),
        v.literal("error"),
      ),
    ),
    instanceId: v.optional(v.string()),
    publicHost: v.optional(v.string()),
    runningAt: v.optional(v.number()),
    healthyAt: v.optional(v.number()),
    terminatedAt: v.optional(v.number()),
    terminateReason: v.optional(v.string()),
    bootLogRef: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { attemptWorkerId, ...rest } = args;
    const updates = Object.fromEntries(
      Object.entries(rest).filter(([, value]) => value !== undefined),
    );
    await ctx.db.patch(attemptWorkerId, updates);
  },
});

export const getByClaim = internalQuery({
  args: { claimId: v.id("bountyClaims") },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("attemptWorkers")
      .withIndex("by_claimId", (q) => q.eq("claimId", args.claimId))
      .collect();
    if (rows.length === 0) return null;
    return rows.sort((a, b) => b.launchRequestedAt - a.launchRequestedAt)[0];
  },
});

export const getByWorkspaceId = internalQuery({
  args: { workspaceId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("attemptWorkers")
      .withIndex("by_workspaceId", (q) => q.eq("workspaceId", args.workspaceId))
      .collect();
    if (rows.length === 0) return null;
    return rows.sort((a, b) => b.launchRequestedAt - a.launchRequestedAt)[0];
  },
});

export const recordBootFailure = internalMutation({
  args: {
    attemptWorkerId: v.id("attemptWorkers"),
    message: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.attemptWorkerId, {
      status: "error",
      errorMessage: args.message,
    });
  },
});

export const getByIdInternal = internalQuery({
  args: { attemptWorkerId: v.id("attemptWorkers") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.attemptWorkerId);
  },
});
