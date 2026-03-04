import { internalMutation, internalQuery, mutation } from "./_generated/server";
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

type SearchArgs = {
  requestId?: string;
  agentId?: string;
  bountyId?: string;
  claimId?: string;
  submissionId?: string;
  verificationId?: string;
  workspaceId?: string;
  eventType?: string;
  level?: "info" | "warning" | "error";
  limit?: number;
};

async function fetchSearchRows(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  args: SearchArgs,
  scanLimit: number,
): Promise<Array<Record<string, unknown>>> {
  if (args.submissionId) {
    return await ctx.db
      .query("mcpAuditLogs")
      .withIndex("by_submissionId_and_createdAt", (q: any) =>
        q.eq("submissionId", args.submissionId)
      )
      .order("desc")
      .take(scanLimit);
  }
  if (args.verificationId) {
    return await ctx.db
      .query("mcpAuditLogs")
      .withIndex("by_verificationId_and_createdAt", (q: any) =>
        q.eq("verificationId", args.verificationId)
      )
      .order("desc")
      .take(scanLimit);
  }
  if (args.agentId) {
    return await ctx.db
      .query("mcpAuditLogs")
      .withIndex("by_agentId_and_createdAt", (q: any) => q.eq("agentId", args.agentId))
      .order("desc")
      .take(scanLimit);
  }
  if (args.bountyId) {
    return await ctx.db
      .query("mcpAuditLogs")
      .withIndex("by_bountyId_and_createdAt", (q: any) => q.eq("bountyId", args.bountyId))
      .order("desc")
      .take(scanLimit);
  }
  if (args.claimId) {
    return await ctx.db
      .query("mcpAuditLogs")
      .withIndex("by_claimId_and_createdAt", (q: any) => q.eq("claimId", args.claimId))
      .order("desc")
      .take(scanLimit);
  }
  if (args.workspaceId) {
    return await ctx.db
      .query("mcpAuditLogs")
      .withIndex("by_workspaceId_and_createdAt", (q: any) => q.eq("workspaceId", args.workspaceId))
      .order("desc")
      .take(scanLimit);
  }
  if (args.requestId) {
    return await ctx.db
      .query("mcpAuditLogs")
      .withIndex("by_requestId_and_createdAt", (q: any) => q.eq("requestId", args.requestId))
      .order("desc")
      .take(scanLimit);
  }
  if (args.eventType) {
    return await ctx.db
      .query("mcpAuditLogs")
      .withIndex("by_eventType_and_createdAt", (q: any) => q.eq("eventType", args.eventType))
      .order("desc")
      .take(scanLimit);
  }
  if (args.level) {
    return await ctx.db
      .query("mcpAuditLogs")
      .withIndex("by_level_and_createdAt", (q: any) => q.eq("level", args.level))
      .order("desc")
      .take(scanLimit);
  }
  return await ctx.db
    .query("mcpAuditLogs")
    .order("desc")
    .take(scanLimit);
}

function rowMatchesSearchFilters(row: Record<string, unknown>, args: SearchArgs): boolean {
  return (
    (!args.requestId || row.requestId === args.requestId) &&
    (!args.agentId || row.agentId === args.agentId) &&
    (!args.bountyId || row.bountyId === args.bountyId) &&
    (!args.claimId || row.claimId === args.claimId) &&
    (!args.submissionId || row.submissionId === args.submissionId) &&
    (!args.verificationId || row.verificationId === args.verificationId) &&
    (!args.workspaceId || row.workspaceId === args.workspaceId) &&
    (!args.eventType || row.eventType === args.eventType) &&
    (!args.level || row.level === args.level)
  );
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
    const rows = await fetchSearchRows(ctx, args, scanLimit);

    return rows
      .filter((row) => rowMatchesSearchFilters(row, args))
      .slice(0, limit);
  },
});

export const trackProductEvent = mutation({
  args: {
    eventName: v.string(),
    path: v.optional(v.string()),
    detailsJson: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    let userId: string | undefined;

    if (identity) {
      const user = await ctx.db
        .query("users")
        .withIndex("by_clerkId", (q) => q.eq("clerkId", identity.subject))
        .unique();
      userId = user?._id;
    }

    return await ctx.db.insert("mcpAuditLogs", {
      source: "web_ui",
      level: "info",
      eventType: args.eventName,
      message: "Product event",
      agentId: userId,
      path: args.path,
      detailsJson: args.detailsJson,
      createdAt: Date.now(),
    });
  },
});
