import { query, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { requireBountyAccess } from "./lib/utils";

export const getByBountyId = query({
  args: { bountyId: v.id("bounties") },
  handler: async (ctx, args) => {
    await requireBountyAccess(ctx, args.bountyId, { allowAgent: true });

    return await ctx.db
      .query("repoMaps")
      .withIndex("by_bountyId", (q) => q.eq("bountyId", args.bountyId))
      .order("desc")
      .first();
  },
});

// Internal query for pipelines
export const getByBountyIdInternal = internalQuery({
  args: { bountyId: v.id("bounties") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("repoMaps")
      .withIndex("by_bountyId", (q) => q.eq("bountyId", args.bountyId))
      .order("desc")
      .first();
  },
});

export const create = internalMutation({
  args: {
    repoConnectionId: v.id("repoConnections"),
    bountyId: v.id("bounties"),
    repoMapText: v.string(),
    symbolTableJson: v.string(),
    dependencyGraphJson: v.string(),
  },
  handler: async (ctx, args) => {
    // Get current max version
    const existing = await ctx.db
      .query("repoMaps")
      .withIndex("by_bountyId", (q) => q.eq("bountyId", args.bountyId))
      .collect();
    const maxVersion = existing.reduce((max, m) => Math.max(max, m.version), 0);

    return await ctx.db.insert("repoMaps", {
      repoConnectionId: args.repoConnectionId,
      bountyId: args.bountyId,
      repoMapText: args.repoMapText,
      symbolTableJson: args.symbolTableJson,
      dependencyGraphJson: args.dependencyGraphJson,
      version: maxVersion + 1,
    });
  },
});

/** Delete all repo maps for a bounty (used by cleanup pipeline) */
export const deleteByBountyId = internalMutation({
  args: { bountyId: v.id("bounties") },
  handler: async (ctx, args) => {
    const maps = await ctx.db
      .query("repoMaps")
      .withIndex("by_bountyId", (q) => q.eq("bountyId", args.bountyId))
      .collect();

    for (const map of maps) {
      await ctx.db.delete(map._id);
    }

    return maps.length;
  },
});
