import { internalAction } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";

/**
 * Clean up all repo-related data for a cancelled bounty.
 * Deletes: codeChunks (with inline embeddings), repoMaps.
 * Marks the repoConnection as "cleaned" (kept for audit trail).
 */
export const cleanupRepoData = internalAction({
  args: {
    bountyId: v.id("bounties"),
  },
  handler: async (ctx, args) => {
    // 1. Delete code chunks (embeddings are inline, deleted with the rows)
    const chunksDeleted = await ctx.runMutation(
      internal.codeChunks.deleteByBountyId,
      { bountyId: args.bountyId }
    );
    console.log(
      `[cleanupRepoData] Deleted ${chunksDeleted} code chunks for bounty ${args.bountyId}`
    );

    // 2. Delete repo maps
    const mapsDeleted = await ctx.runMutation(
      internal.repoMaps.deleteByBountyId,
      { bountyId: args.bountyId }
    );
    console.log(
      `[cleanupRepoData] Deleted ${mapsDeleted} repo maps for bounty ${args.bountyId}`
    );

    // 3. Mark repo connection as "cleaned" (keep record for audit)
    const conn = await ctx.runQuery(
      internal.repoConnections.getByBountyIdInternal,
      { bountyId: args.bountyId }
    );
    if (conn) {
      await ctx.runMutation(internal.repoConnections.updateStatus, {
        repoConnectionId: conn._id,
        status: "cleaned",
      });
    }

    console.log(
      `[cleanupRepoData] Cleanup complete for bounty ${args.bountyId}`
    );
  },
});
