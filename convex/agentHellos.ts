import { query, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { getCurrentUser, requireAuth } from "./lib/utils";

export const recordFromVerification = internalMutation({
  args: {
    bountyId: v.id("bounties"),
    submissionId: v.id("submissions"),
    verificationId: v.id("verifications"),
    agentId: v.id("users"),
    agentIdentifier: v.string(),
    message: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("agentHellos", {
      bountyId: args.bountyId,
      submissionId: args.submissionId,
      verificationId: args.verificationId,
      agentId: args.agentId,
      agentIdentifier: args.agentIdentifier,
      message: args.message,
      createdAt: Date.now(),
    });
  },
});

export const listRecent = query({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireAuth(await getCurrentUser(ctx));

    const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
    const rows = await ctx.db
      .query("agentHellos")
      .withIndex("by_createdAt")
      .order("desc")
      .take(limit);

    return await Promise.all(
      rows.map(async (row) => {
        const [agent, bounty, handshake] = await Promise.all([
          ctx.db.get(row.agentId),
          ctx.db.get(row.bountyId),
          ctx.db
            .query("stripeHandshakeChecks")
            .withIndex("by_verificationId", (q) => q.eq("verificationId", row.verificationId))
            .order("desc")
            .first(),
        ]);

        return {
          ...row,
          agentName: agent?.name ?? "Unknown agent",
          bountyTitle: bounty?.title ?? "Unknown bounty",
          handshake: handshake
            ? {
                status: handshake.status,
                ready: handshake.ready,
                message: handshake.message,
                checkedAt: handshake.checkedAt,
                payoutsEnabled: handshake.payoutsEnabled,
                chargesEnabled: handshake.chargesEnabled,
                currentlyDueCount: handshake.currentlyDueCount,
              }
            : null,
        };
      }),
    );
  },
});
