import { query, internalMutation, internalAction } from "./_generated/server";
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

export const initiate = internalMutation({
  args: {
    bountyId: v.id("bounties"),
    recipientId: v.id("users"),
    amount: v.number(),
    currency: v.string(),
    method: v.union(v.literal("stripe"), v.literal("web3")),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("payments", {
      ...args,
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
  },
});

/**
 * STUBBED: Payment processing engine
 * In production, this would:
 * 1. For Stripe: Create a PaymentIntent and process the transfer
 * 2. For Web3: Execute a smart contract transaction
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
    // Mark as processing
    await ctx.runMutation(internal.payments.updateStatus, {
      paymentId: args.paymentId,
      status: "processing",
    });

    // TODO: Implement payment processing
    // For Stripe: use Stripe SDK to create transfer
    // For Web3: use ethers.js / viem to execute transaction

    console.log(
      `[STUB] processPayment called for payment ${args.paymentId}, amount: ${args.amount} ${args.currency}`
    );

    // Stub: mark as completed
    await ctx.runMutation(internal.payments.updateStatus, {
      paymentId: args.paymentId,
      status: "completed",
      transactionId: `stub_tx_${Date.now()}`,
    });
  },
});
