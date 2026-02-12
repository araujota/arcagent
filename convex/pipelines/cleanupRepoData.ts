import { internalAction } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { createQdrantClient, getCollectionName } from "../lib/qdrant";

/**
 * Clean up all repo-related data for a cancelled bounty.
 * Deletes: Qdrant vectors, codeChunks, repoMaps.
 * Marks the repoConnection as "cleaned" (kept for audit trail).
 */
export const cleanupRepoData = internalAction({
  args: {
    bountyId: v.id("bounties"),
  },
  handler: async (ctx, args) => {
    // 1. Delete Qdrant vectors
    const qdrantUrl = process.env.QDRANT_URL;
    if (qdrantUrl) {
      try {
        const qdrantClient = createQdrantClient(
          qdrantUrl,
          process.env.QDRANT_API_KEY
        );
        const collectionName = getCollectionName();

        await qdrantClient.deleteByFilter(collectionName, {
          must: [
            {
              key: "bountyId",
              match: { value: args.bountyId },
            },
          ],
        });
        console.log(
          `[cleanupRepoData] Deleted Qdrant vectors for bounty ${args.bountyId}`
        );
      } catch (error) {
        console.warn(
          `[cleanupRepoData] Failed to delete Qdrant vectors: ${error}`
        );
      }
    }

    // 2. Delete code chunks
    const chunksDeleted = await ctx.runMutation(
      internal.codeChunks.deleteByBountyId,
      { bountyId: args.bountyId }
    );
    console.log(
      `[cleanupRepoData] Deleted ${chunksDeleted} code chunks for bounty ${args.bountyId}`
    );

    // 3. Delete repo maps
    const mapsDeleted = await ctx.runMutation(
      internal.repoMaps.deleteByBountyId,
      { bountyId: args.bountyId }
    );
    console.log(
      `[cleanupRepoData] Deleted ${mapsDeleted} repo maps for bounty ${args.bountyId}`
    );

    // 4. Mark repo connection as "cleaned" (keep record for audit)
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
