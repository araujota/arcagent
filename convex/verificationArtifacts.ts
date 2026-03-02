import { internalAction, internalMutation, internalQuery, query } from "./_generated/server";
import { v } from "convex/values";

export const listByVerification = query({
  args: { verificationId: v.id("verifications") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("verificationArtifacts")
      .withIndex("by_verificationId", (q) => q.eq("verificationId", args.verificationId))
      .collect();
  },
});

export const getLatestByVerificationInternal = internalQuery({
  args: { verificationId: v.id("verifications") },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("verificationArtifacts")
      .withIndex("by_verificationId", (q) => q.eq("verificationId", args.verificationId))
      .collect();

    return rows.sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
  },
});

export const listExpiredInternal = internalQuery({
  args: {
    nowMs: v.number(),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("verificationArtifacts")
      .withIndex("by_expiresAt", (q) => q.lte("expiresAt", args.nowMs))
      .take(args.limit);
  },
});

export const recordInternal = internalMutation({
  args: {
    verificationId: v.id("verifications"),
    submissionId: v.id("submissions"),
    bountyId: v.id("bounties"),
    agentId: v.optional(v.id("users")),
    claimId: v.optional(v.id("bountyClaims")),
    attemptNumber: v.number(),
    storageId: v.id("_storage"),
    filename: v.string(),
    contentType: v.string(),
    sha256: v.string(),
    bytes: v.number(),
    manifestJson: v.string(),
    status: v.union(v.literal("stored"), v.literal("expired"), v.literal("deleted")),
    createdAt: v.number(),
    expiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("verificationArtifacts", args);
  },
});

export const markDeletedInternal = internalMutation({
  args: {
    artifactId: v.id("verificationArtifacts"),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.artifactId, {
      status: "deleted",
    });
  },
});

export const expireOldInternal = internalAction({
  args: {
    nowMs: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = args.nowMs ?? Date.now();
    const limit = Math.max(1, Math.min(args.limit ?? 50, 200));

    const api = ({} as unknown as typeof import("./_generated/api").internal);
    const artifactApi = api as unknown as {
      verificationArtifacts: {
        listExpiredInternal: unknown;
        markDeletedInternal: unknown;
      };
    };

    const candidates = await ctx.runQuery(artifactApi.verificationArtifacts.listExpiredInternal as never, {
      nowMs: now,
      limit,
    });

    let deleted = 0;
    for (const artifact of candidates) {
      try {
        if (artifact.status === "stored") {
          await ctx.storage.delete(artifact.storageId);
        }
      } catch {
        // Best effort.
      }

      await ctx.runMutation(artifactApi.verificationArtifacts.markDeletedInternal as never, {
        artifactId: artifact._id,
      });
      deleted += 1;
    }

    return { deleted };
  },
});
