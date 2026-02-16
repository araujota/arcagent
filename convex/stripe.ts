import { action, internalAction, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { calculatePlatformFee, PLATFORM_FEE_RATE } from "./lib/fees";

function getStripe() {
  // Dynamic import workaround for Convex bundling — Stripe is loaded at runtime
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Stripe = require("stripe");
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY not configured");
  return new Stripe(key) as import("stripe").default;
}

// ---------------------------------------------------------------------------
// Stripe Customer
// ---------------------------------------------------------------------------

export const ensureStripeCustomer = internalAction({
  args: {
    userId: v.id("users"),
    email: v.string(),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const stripe = getStripe();

    // Check if user already has a Stripe customer ID
    const user = await ctx.runQuery(internal.users.getByIdInternal, {
      userId: args.userId,
    });

    if (user?.stripeCustomerId) {
      return user.stripeCustomerId;
    }

    const customer = await stripe.customers.create({
      email: args.email,
      name: args.name,
      metadata: { convexUserId: args.userId },
    });

    await ctx.runMutation(internal.stripe.updateUserStripeCustomerId, {
      userId: args.userId,
      stripeCustomerId: customer.id,
    });

    return customer.id;
  },
});

export const updateUserStripeCustomerId = internalMutation({
  args: {
    userId: v.id("users"),
    stripeCustomerId: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.userId, {
      stripeCustomerId: args.stripeCustomerId,
    });
  },
});

// ---------------------------------------------------------------------------
// Setup Intent (for attaching payment methods)
// ---------------------------------------------------------------------------

export const createSetupIntent = internalAction({
  args: {
    userId: v.id("users"),
    email: v.string(),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const stripe = getStripe();

    const customerId = await ctx.runAction(
      internal.stripe.ensureStripeCustomer,
      {
        userId: args.userId,
        email: args.email,
        name: args.name,
      }
    );

    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ["card"],
      metadata: { convexUserId: args.userId },
    });

    return {
      clientSecret: setupIntent.client_secret,
      setupIntentId: setupIntent.id,
      customerId,
    };
  },
});

// ---------------------------------------------------------------------------
// Escrow Charge (fund a bounty)
// ---------------------------------------------------------------------------

export const createEscrowCharge = internalAction({
  args: {
    bountyId: v.id("bounties"),
    userId: v.id("users"),
    amount: v.number(),
    currency: v.string(),
  },
  handler: async (ctx, args) => {
    const stripe = getStripe();

    // Guard: check bounty is in a fundable state
    const bounty = await ctx.runQuery(internal.bounties.getByIdInternal, {
      bountyId: args.bountyId,
    });
    if (!bounty) throw new Error("Bounty not found");
    if (bounty.status !== "active" && bounty.status !== "draft") {
      throw new Error("Bounty is not in a fundable state");
    }
    if (bounty.escrowStatus === "funded") {
      throw new Error("Bounty escrow is already funded");
    }

    const user = await ctx.runQuery(internal.users.getByIdInternal, {
      userId: args.userId,
    });
    if (!user?.stripeCustomerId) {
      throw new Error("User has no Stripe customer. Call setup_payment_method first.");
    }

    // Get the customer's default payment method
    const customer = await stripe.customers.retrieve(user.stripeCustomerId);
    if (customer.deleted) throw new Error("Stripe customer has been deleted");

    const paymentMethods = await stripe.paymentMethods.list({
      customer: user.stripeCustomerId,
      type: "card",
    });

    if (paymentMethods.data.length === 0) {
      throw new Error("No payment method on file. Complete setup_payment_method first.");
    }

    const paymentMethodId = paymentMethods.data[0].id;

    // Create PaymentIntent (escrow charge — funds go to platform account)
    const amountInCents = Math.round(args.amount * 100);
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInCents,
      currency: args.currency.toLowerCase(),
      customer: user.stripeCustomerId,
      payment_method: paymentMethodId,
      off_session: true,
      confirm: true,
      metadata: {
        bountyId: args.bountyId,
        convexUserId: args.userId,
        type: "escrow",
      },
    });

    // Calculate and store platform fee
    const { feeCents, solverCents } = calculatePlatformFee(amountInCents);

    // Update bounty with escrow info and fee breakdown
    await ctx.runMutation(internal.stripe.updateBountyEscrow, {
      bountyId: args.bountyId,
      stripePaymentIntentId: paymentIntent.id,
      escrowStatus: paymentIntent.status === "succeeded" ? "funded" : "unfunded",
    });

    await ctx.runMutation(internal.stripe.storePlatformFee, {
      bountyId: args.bountyId,
      platformFeePercent: PLATFORM_FEE_RATE,
      platformFeeCents: feeCents,
    });

    return {
      paymentIntentId: paymentIntent.id,
      status: paymentIntent.status,
      escrowStatus: paymentIntent.status === "succeeded" ? "funded" : "unfunded",
      platformFeeCents: feeCents,
      solverAmountCents: solverCents,
    };
  },
});

/**
 * SECURITY (C3): State machine guards on escrow transitions.
 * Prevents webhook replay attacks from flipping escrow back to "funded"
 * after a refund or release.
 *
 * Valid transitions: unfunded → funded, funded → released, funded → refunded
 */
const VALID_ESCROW_TRANSITIONS: Record<string, string[]> = {
  unfunded: ["funded"],
  funded: ["released", "refunded"],
  released: [],
  refunded: [],
};

export const updateBountyEscrow = internalMutation({
  args: {
    bountyId: v.id("bounties"),
    stripePaymentIntentId: v.optional(v.string()),
    escrowStatus: v.union(
      v.literal("unfunded"),
      v.literal("funded"),
      v.literal("released"),
      v.literal("refunded")
    ),
  },
  handler: async (ctx, args) => {
    const bounty = await ctx.db.get(args.bountyId);
    if (!bounty) throw new Error("Bounty not found");

    // SECURITY (C3): Enforce escrow state machine
    const currentStatus = bounty.escrowStatus ?? "unfunded";

    // Idempotent no-op: same status → same status is allowed
    if (currentStatus === args.escrowStatus) return;

    const allowed = VALID_ESCROW_TRANSITIONS[currentStatus] ?? [];
    if (!allowed.includes(args.escrowStatus)) {
      throw new Error(
        `Invalid escrow transition: ${currentStatus} → ${args.escrowStatus}`
      );
    }

    const updates: Record<string, unknown> = {
      escrowStatus: args.escrowStatus,
    };
    if (args.stripePaymentIntentId) {
      updates.stripePaymentIntentId = args.stripePaymentIntentId;
    }
    await ctx.db.patch(args.bountyId, updates);
  },
});

export const storePlatformFee = internalMutation({
  args: {
    bountyId: v.id("bounties"),
    platformFeePercent: v.number(),
    platformFeeCents: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.bountyId, {
      platformFeePercent: args.platformFeePercent,
      platformFeeCents: args.platformFeeCents,
    });
  },
});

// ---------------------------------------------------------------------------
// Stripe Connect (solver payout accounts)
// ---------------------------------------------------------------------------

export const createConnectAccount = internalAction({
  args: {
    userId: v.id("users"),
    email: v.string(),
  },
  handler: async (ctx, args) => {
    const stripe = getStripe();
    const appUrl = process.env.APP_URL || "http://localhost:3000";

    // Check if user already has a Connect account
    const user = await ctx.runQuery(internal.users.getByIdInternal, {
      userId: args.userId,
    });

    let accountId = user?.stripeConnectAccountId;

    if (!accountId) {
      const account = await stripe.accounts.create({
        type: "express",
        email: args.email,
        metadata: { convexUserId: args.userId },
      });
      accountId = account.id;

      await ctx.runMutation(internal.stripe.updateUserConnectAccount, {
        userId: args.userId,
        stripeConnectAccountId: accountId,
      });
    }

    // Create an account link for onboarding
    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${appUrl}/settings/payouts?refresh=true`,
      return_url: `${appUrl}/settings/payouts?success=true`,
      type: "account_onboarding",
    });

    return {
      accountId,
      onboardingUrl: accountLink.url,
    };
  },
});

export const updateUserConnectAccount = internalMutation({
  args: {
    userId: v.id("users"),
    stripeConnectAccountId: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.userId, {
      stripeConnectAccountId: args.stripeConnectAccountId,
    });
  },
});

export const updateConnectOnboardingStatus = internalMutation({
  args: {
    stripeConnectAccountId: v.string(),
    onboardingComplete: v.boolean(),
  },
  handler: async (ctx, args) => {
    // Find user by Connect account ID using index
    const user = await ctx.db
      .query("users")
      .withIndex("by_stripeConnectAccountId", (q) =>
        q.eq("stripeConnectAccountId", args.stripeConnectAccountId)
      )
      .first();
    if (user) {
      await ctx.db.patch(user._id, {
        stripeConnectOnboardingComplete: args.onboardingComplete,
      });
    }
  },
});

// ---------------------------------------------------------------------------
// Release Escrow (transfer to solver)
// ---------------------------------------------------------------------------

export const releaseEscrow = internalAction({
  args: {
    bountyId: v.id("bounties"),
    recipientUserId: v.id("users"),
    paymentId: v.id("payments"),
  },
  handler: async (ctx, args) => {
    const stripe = getStripe();

    const bounty = await ctx.runQuery(internal.bounties.getByIdInternal, {
      bountyId: args.bountyId,
    });
    if (!bounty) throw new Error("Bounty not found");

    // SECURITY (M2): Prevent escrow release if bounty has been cancelled
    if (bounty.status === "cancelled") {
      throw new Error("Cannot release escrow: bounty is cancelled");
    }

    if (bounty.escrowStatus !== "funded") {
      throw new Error(`Cannot release escrow: status is ${bounty.escrowStatus}`);
    }

    const recipient = await ctx.runQuery(internal.users.getByIdInternal, {
      userId: args.recipientUserId,
    });
    if (!recipient?.stripeConnectAccountId) {
      throw new Error("Recipient has no Stripe Connect account");
    }

    // SECURITY: Verify Connect onboarding is complete before transferring funds
    if (!recipient.stripeConnectOnboardingComplete) {
      throw new Error(
        "Recipient has not completed Stripe Connect onboarding. Payout will be retried once onboarding is complete."
      );
    }

    // Transfer net amount (minus platform fee) to solver's Connect account
    const grossCents = Math.round(bounty.reward * 100);
    // Use stored fee if available, otherwise calculate from current rate
    const feeCents = bounty.platformFeeCents ?? Math.round(grossCents * PLATFORM_FEE_RATE);
    const solverCents = grossCents - feeCents;

    const transfer = await stripe.transfers.create({
      amount: solverCents,
      currency: bounty.rewardCurrency.toLowerCase(),
      destination: recipient.stripeConnectAccountId,
      metadata: {
        bountyId: args.bountyId,
        recipientUserId: args.recipientUserId,
      },
    }, {
      idempotencyKey: `release_${args.bountyId}_${args.paymentId}`,
    });

    // Update bounty escrow status
    await ctx.runMutation(internal.stripe.updateBountyEscrow, {
      bountyId: args.bountyId,
      escrowStatus: "released",
    });

    // Update payment record
    await ctx.runMutation(internal.stripe.updatePaymentStripeIds, {
      paymentId: args.paymentId,
      stripeTransferId: transfer.id,
      stripePaymentIntentId: bounty.stripePaymentIntentId,
    });

    await ctx.runMutation(internal.payments.updateStatus, {
      paymentId: args.paymentId,
      status: "completed",
      transactionId: transfer.id,
    });

    return { transferId: transfer.id };
  },
});

export const updatePaymentStripeIds = internalMutation({
  args: {
    paymentId: v.id("payments"),
    stripePaymentIntentId: v.optional(v.string()),
    stripeTransferId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const updates: Record<string, unknown> = {};
    if (args.stripePaymentIntentId) {
      updates.stripePaymentIntentId = args.stripePaymentIntentId;
    }
    if (args.stripeTransferId) {
      updates.stripeTransferId = args.stripeTransferId;
    }
    await ctx.db.patch(args.paymentId, updates);
  },
});

// ---------------------------------------------------------------------------
// Refund Escrow
// ---------------------------------------------------------------------------

export const refundEscrow = internalAction({
  args: {
    bountyId: v.id("bounties"),
  },
  handler: async (ctx, args) => {
    const stripe = getStripe();

    const bounty = await ctx.runQuery(internal.bounties.getByIdInternal, {
      bountyId: args.bountyId,
    });
    if (!bounty) throw new Error("Bounty not found");
    if (bounty.escrowStatus !== "funded") {
      throw new Error(`Cannot refund: escrow status is ${bounty.escrowStatus}`);
    }
    if (!bounty.stripePaymentIntentId) {
      throw new Error("No payment intent found for this bounty");
    }

    const refund = await stripe.refunds.create({
      payment_intent: bounty.stripePaymentIntentId,
      metadata: { bountyId: args.bountyId },
    }, {
      idempotencyKey: `refund_${args.bountyId}_${bounty.stripePaymentIntentId}`,
    });

    await ctx.runMutation(internal.stripe.updateBountyEscrow, {
      bountyId: args.bountyId,
      escrowStatus: "refunded",
    });

    return { refundId: refund.id };
  },
});

// ---------------------------------------------------------------------------
// Retry failed refunds
// ---------------------------------------------------------------------------

/**
 * Retries refunds for cancelled bounties that are still in "funded" escrow status.
 * This handles cases where the initial refund call to Stripe failed.
 */
export const retryFailedRefunds = internalAction({
  args: {},
  handler: async (ctx) => {
    const stuckBounties = await ctx.runQuery(
      internal.bounties.listCancelledWithFundedEscrow,
      {}
    );

    let retried = 0;
    for (const bounty of stuckBounties) {
      try {
        await ctx.runAction(internal.stripe.refundEscrow, {
          bountyId: bounty._id,
        });
        retried++;
      } catch (err) {
        console.error(
          `[retryFailedRefunds] Failed to refund bounty ${bounty._id}:`,
          err instanceof Error ? err.message : String(err)
        );
      }
    }

    if (retried > 0) {
      console.log(`[retryFailedRefunds] Retried ${retried} refunds`);
    }
  },
});

// ---------------------------------------------------------------------------
// Retry failed payouts
// ---------------------------------------------------------------------------

/**
 * Retries payouts for bounties where escrow release failed (e.g., agent hadn't
 * completed Connect onboarding). Checks every 15 minutes, gives up after 7 days.
 */
export const retryFailedPayouts = internalAction({
  args: {},
  handler: async (ctx) => {
    const failedPayments = await ctx.runQuery(
      internal.payments.getFailedPayouts,
      {}
    );

    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
    let retried = 0;

    for (const payment of failedPayments) {
      // Skip if older than 7 days — mark for manual review
      if (Date.now() - payment.createdAt > SEVEN_DAYS_MS) {
        console.warn(
          `[retryFailedPayouts] Payment ${payment._id} is >7 days old, skipping. Requires manual review.`
        );
        continue;
      }

      try {
        await ctx.runAction(internal.stripe.releaseEscrow, {
          bountyId: payment.bountyId,
          recipientUserId: payment.recipientId,
          paymentId: payment._id,
        });

        // Mark bounty as completed if not already
        const bounty = await ctx.runQuery(internal.bounties.getByIdInternal, {
          bountyId: payment.bountyId,
        });
        if (bounty && bounty.status !== "completed") {
          await ctx.runMutation(internal.bounties.updateStatusInternal, {
            bountyId: payment.bountyId,
            status: "completed",
          });
        }

        retried++;
      } catch (err) {
        console.error(
          `[retryFailedPayouts] Failed to retry payment ${payment._id}:`,
          err instanceof Error ? err.message : String(err)
        );
      }
    }

    if (retried > 0) {
      console.log(`[retryFailedPayouts] Retried ${retried} payouts`);
    }
  },
});

// ---------------------------------------------------------------------------
// Public Actions (for onboarding / settings pages)
// ---------------------------------------------------------------------------

/**
 * Create a SetupIntent for the current authenticated user.
 * Used by the onboarding wizard and settings page to save a payment method.
 */
export const createSetupIntentForCurrentUser = internalAction({
  args: {
    userId: v.id("users"),
    email: v.string(),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    return ctx.runAction(internal.stripe.createSetupIntent, {
      userId: args.userId,
      email: args.email,
      name: args.name,
    });
  },
});

/**
 * Create a Stripe Connect onboarding link for the current authenticated user.
 * Used by agents to set up payout accounts.
 */
export const createConnectOnboardingForCurrentUser = internalAction({
  args: {
    userId: v.id("users"),
    email: v.string(),
  },
  handler: async (ctx, args) => {
    return ctx.runAction(internal.stripe.createConnectAccount, {
      userId: args.userId,
      email: args.email,
    });
  },
});

// ---------------------------------------------------------------------------
// Public Actions (Clerk-authed, for web UI)
// ---------------------------------------------------------------------------

/** Helper: get user by Clerk subject ID */
export const getUserByClerkSubject = internalQuery({
  args: { clerkId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("users")
      .withIndex("by_clerkId", (q) => q.eq("clerkId", args.clerkId))
      .unique();
  },
});

/**
 * Public action: create a SetupIntent for the current user.
 * Returns a client secret for Stripe hosted setup page.
 */
export const setupPaymentMethod = action({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Authentication required");

    const user = await ctx.runQuery(internal.stripe.getUserByClerkSubject, {
      clerkId: identity.subject,
    });
    if (!user) throw new Error("User not found");

    const result = await ctx.runAction(internal.stripe.createSetupIntent, {
      userId: user._id,
      email: user.email,
      name: user.name,
    });

    const appUrl = process.env.APP_URL || "http://localhost:3000";
    return {
      clientSecret: result.clientSecret,
      setupIntentId: result.setupIntentId,
      returnUrl: `${appUrl}/settings?setup_complete=true`,
    };
  },
});

/**
 * Public action: create or resume Stripe Connect onboarding.
 * Returns the onboarding URL to redirect the user to.
 */
export const setupPayoutAccount = action({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Authentication required");

    const user = await ctx.runQuery(internal.stripe.getUserByClerkSubject, {
      clerkId: identity.subject,
    });
    if (!user) throw new Error("User not found");

    const result = await ctx.runAction(internal.stripe.createConnectAccount, {
      userId: user._id,
      email: user.email,
    });

    return {
      onboardingUrl: result.onboardingUrl,
      accountId: result.accountId,
    };
  },
});
