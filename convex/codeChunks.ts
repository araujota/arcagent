import { query, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";

export const listByBounty = query({
  args: { bountyId: v.id("bounties") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("codeChunks")
      .withIndex("by_bountyId", (q) => q.eq("bountyId", args.bountyId))
      .collect();
  },
});

export const listByRepoConnection = internalQuery({
  args: { repoConnectionId: v.id("repoConnections") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("codeChunks")
      .withIndex("by_repoConnectionId", (q) =>
        q.eq("repoConnectionId", args.repoConnectionId)
      )
      .collect();
  },
});

export const createBatch = internalMutation({
  args: {
    repoConnectionId: v.id("repoConnections"),
    bountyId: v.id("bounties"),
    chunksJson: v.string(),
  },
  handler: async (ctx, args) => {
    const chunks: Array<{
      filePath: string;
      symbolName: string;
      symbolType: string;
      language: string;
      content: string;
      startLine: number;
      endLine: number;
      parentScope: string | null;
      signature: string | null;
    }> = JSON.parse(args.chunksJson);

    const validSymbolTypes = [
      "function",
      "class",
      "interface",
      "type",
      "method",
      "module",
      "enum",
      "constant",
    ] as const;

    for (const chunk of chunks) {
      const symbolType = validSymbolTypes.includes(
        chunk.symbolType as (typeof validSymbolTypes)[number]
      )
        ? (chunk.symbolType as (typeof validSymbolTypes)[number])
        : "function";

      await ctx.db.insert("codeChunks", {
        repoConnectionId: args.repoConnectionId,
        bountyId: args.bountyId,
        filePath: chunk.filePath,
        symbolName: chunk.symbolName,
        symbolType,
        language: chunk.language,
        content: chunk.content,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        parentScope: chunk.parentScope || undefined,
        signature: chunk.signature || undefined,
      });
    }
  },
});

export const updateQdrantId = internalMutation({
  args: {
    chunkId: v.id("codeChunks"),
    qdrantPointId: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.chunkId, {
      qdrantPointId: args.qdrantPointId,
    });
  },
});
