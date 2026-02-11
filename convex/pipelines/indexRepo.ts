import { internalAction } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { createEmbeddingClient, formatChunkForEmbedding } from "../lib/embeddings";
import { createQdrantClient, getCollectionName } from "../lib/qdrant";

/**
 * RAG indexing pipeline.
 * Generates embeddings for all code chunks and upserts to Qdrant.
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

      // Initialize Qdrant client
      const qdrantUrl = process.env.QDRANT_URL;
      if (!qdrantUrl) {
        throw new Error("QDRANT_URL environment variable is not set");
      }
      const qdrantClient = createQdrantClient(
        qdrantUrl,
        process.env.QDRANT_API_KEY
      );

      const collectionName = getCollectionName();

      // Ensure collection exists
      await qdrantClient.ensureCollection(
        collectionName,
        embeddingClient.dimensions
      );

      // Delete any existing vectors for this bounty (re-indexing)
      await qdrantClient.deleteByFilter(collectionName, {
        must: [
          {
            key: "bountyId",
            match: { value: args.bountyId },
          },
        ],
      });

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

      // Build Qdrant points
      const points = chunks.map((chunk, i) => {
        const pointId = crypto.randomUUID();
        return {
          id: pointId,
          vector: allEmbeddings[i],
          payload: {
            bountyId: args.bountyId,
            repoConnectionId: args.repoConnectionId,
            filePath: chunk.filePath,
            symbolName: chunk.symbolName,
            symbolType: chunk.symbolType,
            language: chunk.language,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            parentScope: chunk.parentScope || "",
            signature: chunk.signature || "",
            content: chunk.content,
            convexChunkId: chunk._id,
          },
        };
      });

      // Upsert to Qdrant
      console.log(`Upserting ${points.length} points to Qdrant...`);
      await qdrantClient.upsertPoints(collectionName, points);

      // Update chunk records with Qdrant point IDs
      for (let i = 0; i < chunks.length; i++) {
        await ctx.runMutation(internal.codeChunks.updateQdrantId, {
          chunkId: chunks[i]._id,
          qdrantPointId: points[i].id,
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
        `Indexing complete: ${points.length} chunks indexed for bounty ${args.bountyId}`
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
