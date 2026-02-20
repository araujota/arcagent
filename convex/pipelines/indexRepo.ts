import { internalAction } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { createEmbeddingClient, formatChunkForEmbedding } from "../lib/embeddings";

/**
 * RAG indexing pipeline.
 * Generates embeddings for all code chunks and stores them inline via Convex vector search.
 *
 * Pipeline chain: fetchRepo → ensureDockerfile → parseRepo → indexRepo
 */
export const indexRepo = internalAction({
  args: {
    repoConnectionId: v.id("repoConnections"),
    bountyId: v.id("bounties"),
  },
  handler: async (ctx, args) => {
    try {
      // Get all code chunks for this repo connection
      const chunks = await ctx.runQuery(internal.codeChunks.listByRepoConnection, {
        repoConnectionId: args.repoConnectionId,
      });

      if (chunks.length === 0) {
        console.log("No code chunks to index, marking as ready");
        await ctx.runMutation(internal.repoConnections.updateStatus, {
          repoConnectionId: args.repoConnectionId,
          status: "ready",
        });
        await ctx.runMutation(internal.repoConnections.markIndexed, {
          repoConnectionId: args.repoConnectionId,
        });
        return;
      }

      // Initialize embedding client
      const embeddingClient = createEmbeddingClient(
        process.env.VOYAGE_AI_API_KEY,
        process.env.OPENAI_API_KEY
      );

      // Format chunks for embedding
      const embeddingTexts = chunks.map((chunk) =>
        formatChunkForEmbedding({
          filePath: chunk.filePath,
          symbolName: chunk.symbolName,
          symbolType: chunk.symbolType,
          content: chunk.content,
        })
      );

      // Generate embeddings in batches
      console.log(`Generating embeddings for ${chunks.length} chunks...`);
      const allEmbeddings = await embeddingClient.embed(embeddingTexts);

      // Patch embeddings onto existing codeChunks rows in batches of 25
      const BATCH_SIZE = 25;
      for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
        const batchIds = chunks.slice(i, i + BATCH_SIZE).map((c) => c._id);
        const batchEmbeddings = allEmbeddings.slice(i, i + BATCH_SIZE);
        await ctx.runMutation(internal.codeChunks.updateEmbeddingsBatch, {
          ids: batchIds,
          embeddings: batchEmbeddings,
        });
      }

      // Mark as ready
      await ctx.runMutation(internal.repoConnections.updateStatus, {
        repoConnectionId: args.repoConnectionId,
        status: "ready",
      });

      await ctx.runMutation(internal.repoConnections.markIndexed, {
        repoConnectionId: args.repoConnectionId,
      });

      console.log(
        `Indexing complete: ${chunks.length} chunks indexed for bounty ${args.bountyId}`
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error during indexing";
      console.error(`indexRepo failed: ${errorMessage}`);

      await ctx.runMutation(internal.repoConnections.updateStatus, {
        repoConnectionId: args.repoConnectionId,
        status: "failed",
        errorMessage,
      });
    }
  },
});
