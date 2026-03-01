import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";

const LOG_LEVEL_VALIDATOR = v.union(
  v.literal("info"),
  v.literal("warning"),
  v.literal("error"),
);

const SEARCH_MAX_LIMIT = 2000;
const SEARCH_DEFAULT_LIMIT = 200;
const SEARCH_SCAN_MULTIPLIER = 5;

function normalizeLimit(limit?: number): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return SEARCH_DEFAULT_LIMIT;
  const normalized = Math.floor(limit);
  if (normalized < 1) return 1;
  if (normalized > SEARCH_MAX_LIMIT) return SEARCH_MAX_LIMIT;
  return normalized;
}

export const insert = internalMutation({
  args: {
    source: v.string(),
    level: LOG_LEVEL_VALIDATOR,
    eventType: v.string(),
    message: v.string(),
    requestId: v.optional(v.string()),
    agentId: v.optional(v.string()),
    bountyId: v.optional(v.string()),
    claimId: v.optional(v.string()),
    submissionId: v.optional(v.string()),
    verificationId: v.optional(v.string()),
    workspaceId: v.optional(v.string()),
    sessionId: v.optional(v.string()),
    path: v.optional(v.string()),
    method: v.optional(v.string()),
    statusCode: v.optional(v.number()),
    durationMs: v.optional(v.number()),
    detailsJson: v.optional(v.string()),
    createdAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("mcpAuditLogs", {
      ...args,
      createdAt: args.createdAt ?? Date.now(),
    });
  },
});

export const searchInternal = internalQuery({
  args: {
    requestId: v.optional(v.string()),
    agentId: v.optional(v.string()),
    bountyId: v.optional(v.string()),
    claimId: v.optional(v.string()),
    submissionId: v.optional(v.string()),
    verificationId: v.optional(v.string()),
    workspaceId: v.optional(v.string()),
    eventType: v.optional(v.string()),
    level: v.optional(LOG_LEVEL_VALIDATOR),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = normalizeLimit(args.limit);
    const scanLimit = Math.min(limit * SEARCH_SCAN_MULTIPLIER, SEARCH_MAX_LIMIT);

    let rows: Array<Record<string, unknown>>;
    if (args.submissionId) {
      rows = await ctx.db
        .query("mcpAuditLogs")
        .withIndex("by_submissionId_and_createdAt", (q) =>
          q.eq("submissionId", args.submissionId)
        )
        .order("desc")
        .take(scanLimit);
    } else if (args.verificationId) {
      rows = await ctx.db
        .query("mcpAuditLogs")
        .withIndex("by_verificationId_and_createdAt", (q) =>
          q.eq("verificationId", args.verificationId)
        )
        .order("desc")
        .take(scanLimit);
    } else if (args.agentId) {
      rows = await ctx.db
        .query("mcpAuditLogs")
        .withIndex("by_agentId_and_createdAt", (q) => q.eq("agentId", args.agentId))
        .order("desc")
        .take(scanLimit);
    } else if (args.bountyId) {
      rows = await ctx.db
        .query("mcpAuditLogs")
        .withIndex("by_bountyId_and_createdAt", (q) => q.eq("bountyId", args.bountyId))
        .order("desc")
        .take(scanLimit);
    } else if (args.claimId) {
      rows = await ctx.db
        .query("mcpAuditLogs")
        .withIndex("by_claimId_and_createdAt", (q) => q.eq("claimId", args.claimId))
        .order("desc")
        .take(scanLimit);
    } else if (args.workspaceId) {
      rows = await ctx.db
        .query("mcpAuditLogs")
        .withIndex("by_workspaceId_and_createdAt", (q) => q.eq("workspaceId", args.workspaceId))
        .order("desc")
        .take(scanLimit);
    } else if (args.requestId) {
      rows = await ctx.db
        .query("mcpAuditLogs")
        .withIndex("by_requestId_and_createdAt", (q) => q.eq("requestId", args.requestId))
        .order("desc")
        .take(scanLimit);
    } else if (args.eventType) {
      rows = await ctx.db
        .query("mcpAuditLogs")
        .withIndex("by_eventType_and_createdAt", (q) => q.eq("eventType", args.eventType))
        .order("desc")
        .take(scanLimit);
    } else if (args.level) {
      rows = await ctx.db
        .query("mcpAuditLogs")
        .withIndex("by_level_and_createdAt", (q) => q.eq("level", args.level))
        .order("desc")
        .take(scanLimit);
    } else {
      rows = await ctx.db
        .query("mcpAuditLogs")
        .order("desc")
        .take(scanLimit);
    }

    return rows
      .filter((row) => {
        if (args.requestId && row.requestId !== args.requestId) return false;
        if (args.agentId && row.agentId !== args.agentId) return false;
        if (args.bountyId && row.bountyId !== args.bountyId) return false;
        if (args.claimId && row.claimId !== args.claimId) return false;
        if (args.submissionId && row.submissionId !== args.submissionId) return false;
        if (args.verificationId && row.verificationId !== args.verificationId) return false;
        if (args.workspaceId && row.workspaceId !== args.workspaceId) return false;
        if (args.eventType && row.eventType !== args.eventType) return false;
        if (args.level && row.level !== args.level) return false;
        return true;
      })
      .slice(0, limit);
  },
});
