import { query, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { requireBountyAccess } from "./lib/utils";

export const listByBounty = query({
  args: { bountyId: v.id("bounties") },
  handler: async (ctx, args) => {
    await requireBountyAccess(ctx, args.bountyId, { allowAgent: true });

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

/** Batch-update embeddings on existing code chunks */
export const updateEmbeddingsBatch = internalMutation({
  args: {
    ids: v.array(v.id("codeChunks")),
    embeddings: v.array(v.array(v.float64())),
  },
  handler: async (ctx, args) => {
    for (let i = 0; i < args.ids.length; i++) {
      await ctx.db.patch(args.ids[i], {
        embedding: args.embeddings[i],
      });
    }
  },
});

/** Fetch multiple code chunks by ID (for vector search follow-up) */
export const getByIds = internalQuery({
  args: { ids: v.array(v.id("codeChunks")) },
  handler: async (ctx, args) => {
    const docs = await Promise.all(args.ids.map((id) => ctx.db.get(id)));
    return docs.filter((d): d is NonNullable<typeof d> => d !== null);
  },
});

/** Delete all code chunks for a bounty (used by cleanup pipeline) */
export const deleteByBountyId = internalMutation({
  args: { bountyId: v.id("bounties") },
  handler: async (ctx, args) => {
    const chunks = await ctx.db
      .query("codeChunks")
      .withIndex("by_bountyId", (q) => q.eq("bountyId", args.bountyId))
      .collect();

    for (const chunk of chunks) {
      await ctx.db.delete(chunk._id);
    }

    return chunks.length;
  },
});
