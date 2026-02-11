import { internalAction } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { createEmbeddingClient } from "../lib/embeddings";
import { createQdrantClient, getCollectionName } from "../lib/qdrant";

/**
 * RAG retrieval pipeline.
 * Retrieves relevant code context for a bounty description/query.
 * Called by the NL→BDD orchestrator before LLM generation.
 *
 * Returns structured context object:
 * - repoMapText: compact repo overview
 * - relevantChunks: top matching code snippets
 * - dependencySignatures: signatures of related functions
 */
export const retrieveContext = internalAction({
  args: {
    bountyId: v.id("bounties"),
    query: v.string(),
    topK: v.optional(v.number()),
    scoreThreshold: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{
    repoMapText: string;
    relevantChunks: Array<{
      filePath: string;
      symbolName: string;
      symbolType: string;
      content: string;
      score: number;
    }>;
    dependencySignatures: string[];
    totalContextTokens: number;
  }> => {
    const topK = args.topK || 20;
    const scoreThreshold = args.scoreThreshold || 0.3;

    // Get the repo map for this bounty
    const repoMap = await ctx.runQuery(internal.repoMaps.getByBountyIdInternal, {
      bountyId: args.bountyId,
    });

    if (!repoMap) {
      return {
        repoMapText: "",
        relevantChunks: [],
        dependencySignatures: [],
        totalContextTokens: 0,
      };
    }

    // Initialize embedding client
    const embeddingClient = createEmbeddingClient(
      process.env.VOYAGE_AI_API_KEY,
      process.env.OPENAI_API_KEY
    );

    // Initialize Qdrant client
    const qdrantUrl = process.env.QDRANT_URL;
    if (!qdrantUrl) {
      // Return repo map only if Qdrant is not configured
      return {
        repoMapText: repoMap.repoMapText,
        relevantChunks: [],
        dependencySignatures: [],
        totalContextTokens: estimateTokens(repoMap.repoMapText),
      };
    }

    const qdrantClient = createQdrantClient(
      qdrantUrl,
      process.env.QDRANT_API_KEY
    );

    // Embed the query
    const [queryVector] = await embeddingClient.embed([args.query]);

    // Search Qdrant filtered by bountyId
    const searchResults = await qdrantClient.search(
      getCollectionName(),
      queryVector,
      topK,
      {
        must: [
          {
            key: "bountyId",
            match: { value: args.bountyId },
          },
        ],
      }
    );

    // Filter by score threshold and extract chunks
    const relevantChunks = searchResults
      .filter((r) => r.score >= scoreThreshold)
      .slice(0, 10) // Top 10 for context
      .map((r) => ({
        filePath: r.payload.filePath as string,
        symbolName: r.payload.symbolName as string,
        symbolType: r.payload.symbolType as string,
        content: r.payload.content as string,
        score: r.score,
      }));

    // Extract dependency signatures from the symbol table
    const dependencySignatures: string[] = [];
    try {
      const symbolTable = JSON.parse(repoMap.symbolTableJson) as Array<{
        name: string;
        signature: string | null;
        filePath: string;
        exported: boolean;
      }>;

      // Find symbols that are referenced by the relevant chunks
      const relevantPaths = new Set(relevantChunks.map((c) => c.filePath));
      const depGraph = JSON.parse(repoMap.dependencyGraphJson) as {
        edges: Array<{ from: string; to: string }>;
      };

      // Get files that the relevant files depend on
      const dependencyPaths = new Set<string>();
      for (const edge of depGraph.edges) {
        if (relevantPaths.has(edge.from) && edge.to) {
          dependencyPaths.add(edge.to);
        }
      }

      // Get exported signatures from dependency files
      for (const sym of symbolTable) {
        if (
          dependencyPaths.has(sym.filePath) &&
          sym.exported &&
          sym.signature
        ) {
          dependencySignatures.push(`${sym.filePath}: ${sym.signature}`);
        }
      }
    } catch {
      // Ignore errors parsing the symbol table/dep graph
    }

    // Estimate total context tokens
    const totalText =
      repoMap.repoMapText +
      relevantChunks.map((c) => c.content).join("\n") +
      dependencySignatures.join("\n");
    const totalContextTokens = estimateTokens(totalText);

    return {
      repoMapText: repoMap.repoMapText,
      relevantChunks,
      dependencySignatures: dependencySignatures.slice(0, 30), // Limit
      totalContextTokens,
    };
  },
});

function estimateTokens(text: string): number {
  // Rough estimate: ~4 chars per token
  return Math.ceil(text.length / 4);
}
