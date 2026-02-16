import { query, internalMutation, internalAction, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";

export const getByBounty = query({
  args: { bountyId: v.id("bounties") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("payments")
      .withIndex("by_bountyId", (q) => q.eq("bountyId", args.bountyId))
      .first();
  },
});

export const listByRecipient = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];

    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkId", (q) => q.eq("clerkId", identity.subject))
      .unique();
    if (!user) return [];

    const payments = await ctx.db
      .query("payments")
      .withIndex("by_recipientId", (q) => q.eq("recipientId", user._id))
      .collect();

    return await Promise.all(
      payments.map(async (p) => {
        const bounty = await ctx.db.get(p.bountyId);
        return { ...p, bounty };
      })
    );
  },
});

export const getByBountyInternal = internalQuery({
  args: { bountyId: v.id("bounties") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("payments")
      .withIndex("by_bountyId", (q) => q.eq("bountyId", args.bountyId))
      .first();
  },
});

export const getByIdInternal = internalQuery({
  args: { paymentId: v.id("payments") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.paymentId);
  },
});

export const initiate = internalMutation({
  args: {
    bountyId: v.id("bounties"),
    recipientId: v.id("users"),
    amount: v.number(),
    currency: v.string(),
    method: v.union(v.literal("stripe"), v.literal("web3")),
    platformFeeCents: v.optional(v.number()),
    solverAmountCents: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("payments", {
      bountyId: args.bountyId,
      recipientId: args.recipientId,
      amount: args.amount,
      currency: args.currency,
      method: args.method,
      platformFeeCents: args.platformFeeCents,
      solverAmountCents: args.solverAmountCents,
      status: "pending",
      createdAt: Date.now(),
    });
  },
});

export const updateStatus = internalMutation({
  args: {
    paymentId: v.id("payments"),
    status: v.union(
      v.literal("pending"),
      v.literal("processing"),
      v.literal("completed"),
      v.literal("failed")
    ),
    transactionId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const updates: Record<string, unknown> = { status: args.status };
    if (args.transactionId !== undefined)
      updates.transactionId = args.transactionId;
    await ctx.db.patch(args.paymentId, updates);

    if (args.status === "completed") {
      const payment = await ctx.db.get(args.paymentId);
      if (payment) {
        const bounty = await ctx.db.get(payment.bountyId);
        const agent = await ctx.db.get(payment.recipientId);
        if (bounty) {
          await ctx.scheduler.runAfter(0, internal.activityFeed.record, {
            type: "payout_sent",
            bountyId: payment.bountyId,
            bountyTitle: bounty.title,
            amount: payment.amount,
            currency: payment.currency,
            actorName: agent?.name ?? "An agent",
          });
        }
      }
    }
  },
});

/**
 * Payment processing engine.
 * For Stripe: delegates to the escrow release flow in convex/stripe.ts.
 * For Web3: still stubbed (future implementation).
 */
export const processPayment = internalAction({
  args: {
    paymentId: v.id("payments"),
    bountyId: v.id("bounties"),
    recipientId: v.id("users"),
    amount: v.number(),
    currency: v.string(),
    method: v.union(v.literal("stripe"), v.literal("web3")),
  },
  handler: async (ctx, args) => {
    // Guard: only process payments that are pending or failed (retry)
    const payment = await ctx.runQuery(internal.payments.getByIdInternal, {
      paymentId: args.paymentId,
    });
    if (!payment || (payment.status !== "pending" && payment.status !== "failed")) {
      console.log(`[payments] Skipping payment ${args.paymentId}: status is ${payment?.status}`);
      return;
    }

    await ctx.runMutation(internal.payments.updateStatus, {
      paymentId: args.paymentId,
      status: "processing",
    });

    if (args.method === "stripe") {
      try {
        await ctx.runAction(internal.stripe.releaseEscrow, {
          bountyId: args.bountyId,
          recipientUserId: args.recipientId,
          paymentId: args.paymentId,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : "Stripe transfer failed";
        console.error(`[payments] Stripe release failed: ${msg}`);
        await ctx.runMutation(internal.payments.updateStatus, {
          paymentId: args.paymentId,
          status: "failed",
        });
      }
    } else {
      // Web3 — still stubbed
      console.log(
        `[STUB] Web3 processPayment called for payment ${args.paymentId}, amount: ${args.amount} ${args.currency}`
      );
      await ctx.runMutation(internal.payments.updateStatus, {
        paymentId: args.paymentId,
        status: "completed",
        transactionId: `stub_web3_tx_${Date.now()}`,
      });
    }
  },
});
