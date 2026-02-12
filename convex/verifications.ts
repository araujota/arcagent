import { query, internalMutation, internalAction, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { getCurrentUser, requireAuth } from "./lib/utils";

/**
 * SECURITY (H8/M8): Require that the caller is the bounty creator,
 * the submitting agent, or an admin to view verification details.
 */
async function requireBountyAccess(
  ctx: { db: { get: (id: unknown) => Promise<unknown> } },
  userId: string,
  userRole: string,
  bountyId: unknown,
  submissionId?: unknown,
): Promise<void> {
  if (userRole === "admin") return;

  // Check if user is the bounty creator
  const bounty = await ctx.db.get(bountyId) as { creatorId: string } | null;
  if (bounty && bounty.creatorId === userId) return;

  // Check if user is the submitting agent
  if (submissionId) {
    const submission = await ctx.db.get(submissionId) as { agentId: string } | null;
    if (submission && submission.agentId === userId) return;
  }

  throw new Error("Access denied: you must be the bounty creator, the submitting agent, or an admin");
}

export const getBySubmission = query({
  args: { submissionId: v.id("submissions") },
  handler: async (ctx, args) => {
    // SECURITY (H8): Require authentication and access check
    const user = requireAuth(await getCurrentUser(ctx));

    const verification = await ctx.db
      .query("verifications")
      .withIndex("by_submissionId", (q) =>
        q.eq("submissionId", args.submissionId)
      )
      .first();

    if (!verification) return null;

    await requireBountyAccess(
      ctx, user._id, user.role, verification.bountyId, args.submissionId
    );

    return verification;
  },
});

export const listByBounty = query({
  args: { bountyId: v.id("bounties") },
  handler: async (ctx, args) => {
    // SECURITY (H8): Require authentication and access check
    const user = requireAuth(await getCurrentUser(ctx));
    await requireBountyAccess(ctx, user._id, user.role, args.bountyId);

    const verifications = await ctx.db
      .query("verifications")
      .withIndex("by_bountyId", (q) => q.eq("bountyId", args.bountyId))
      .collect();

    return await Promise.all(
      verifications.map(async (v) => {
        const submission = await ctx.db.get(v.submissionId);
        return { ...v, submission };
      })
    );
  },
});

export const create = internalMutation({
  args: {
    submissionId: v.id("submissions"),
    bountyId: v.id("bounties"),
    timeoutSeconds: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("verifications", {
      submissionId: args.submissionId,
      bountyId: args.bountyId,
      status: "pending",
      timeoutSeconds: args.timeoutSeconds,
    });
  },
});

export const updateResult = internalMutation({
  args: {
    verificationId: v.id("verifications"),
    status: v.union(
      v.literal("pending"),
      v.literal("running"),
      v.literal("passed"),
      v.literal("failed")
    ),
    result: v.optional(v.string()),
    startedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    errorLog: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { verificationId, ...updates } = args;
    const filteredUpdates = Object.fromEntries(
      Object.entries(updates).filter(([, v]) => v !== undefined)
    );
    await ctx.db.patch(verificationId, filteredUpdates);

    if (args.status === "passed") {
      const verification = await ctx.db.get(verificationId);
      if (verification) {
        const bounty = await ctx.db.get(verification.bountyId);
        const submission = await ctx.db.get(verification.submissionId);
        const agent = submission ? await ctx.db.get(submission.agentId) : null;
        if (bounty) {
          await ctx.scheduler.runAfter(0, internal.activityFeed.record, {
            type: "bounty_resolved",
            bountyId: bounty._id,
            bountyTitle: bounty.title,
            actorName: agent?.name ?? "An agent",
          });
        }
      }
    }
  },
});

export const getFullStatus = internalQuery({
  args: { verificationId: v.id("verifications") },
  handler: async (ctx, args) => {
    const verification = await ctx.db.get(args.verificationId);
    if (!verification) return null;

    const gates = await ctx.db
      .query("sanityGates")
      .withIndex("by_verificationId", (q) =>
        q.eq("verificationId", args.verificationId)
      )
      .collect();

    const steps = await ctx.db
      .query("verificationSteps")
      .withIndex("by_verificationId", (q) =>
        q.eq("verificationId", args.verificationId)
      )
      .collect();

    const job = await ctx.db
      .query("verificationJobs")
      .withIndex("by_verificationId", (q) =>
        q.eq("verificationId", args.verificationId)
      )
      .first();

    return {
      ...verification,
      gates: gates.map((g) => ({
        gateType: g.gateType,
        tool: g.tool,
        status: g.status,
        issues: g.issues,
      })),
      steps: steps.map((s) => ({
        scenarioName: s.scenarioName,
        featureName: s.featureName,
        status: s.status,
        executionTimeMs: s.executionTimeMs,
        output: s.output,
        stepNumber: s.stepNumber,
      })),
      job: job
        ? {
            status: job.status,
            currentGate: job.currentGate,
            queuedAt: job.queuedAt,
            startedAt: job.startedAt,
            completedAt: job.completedAt,
          }
        : null,
    };
  },
});

/**
 * Agent-facing query that filters hidden test details.
 * Public steps: full detail. Hidden steps: aggregate counts only.
 */
export const getAgentStatus = internalQuery({
  args: { verificationId: v.id("verifications") },
  handler: async (ctx, args) => {
    const verification = await ctx.db.get(args.verificationId);
    if (!verification) return null;

    const [gates, steps, job] = await Promise.all([
      ctx.db
        .query("sanityGates")
        .withIndex("by_verificationId", (q) =>
          q.eq("verificationId", args.verificationId)
        )
        .collect(),
      ctx.db
        .query("verificationSteps")
        .withIndex("by_verificationId", (q) =>
          q.eq("verificationId", args.verificationId)
        )
        .collect(),
      ctx.db
        .query("verificationJobs")
        .withIndex("by_verificationId", (q) =>
          q.eq("verificationId", args.verificationId)
        )
        .first(),
    ]);

    // Partition steps by visibility (missing visibility treated as public)
    const publicSteps = steps.filter((s) => s.visibility !== "hidden");
    const hiddenSteps = steps.filter((s) => s.visibility === "hidden");

    // Full detail for public steps
    const publicResults = publicSteps.map((s) => ({
      scenarioName: s.scenarioName,
      featureName: s.featureName,
      status: s.status,
      executionTimeMs: s.executionTimeMs,
      output: s.output,
      stepNumber: s.stepNumber,
    }));

    // Aggregate only for hidden steps
    const hiddenSummary = {
      total: hiddenSteps.length,
      passed: hiddenSteps.filter((s) => s.status === "pass").length,
      failed: hiddenSteps.filter((s) => s.status === "fail").length,
      errors: hiddenSteps.filter((s) => s.status === "error").length,
      skipped: hiddenSteps.filter((s) => s.status === "skip").length,
    };

    return {
      ...verification,
      gates: gates.map((g) => ({
        gateType: g.gateType,
        tool: g.tool,
        status: g.status,
        issues: g.issues,
      })),
      publicSteps: publicResults,
      hiddenTestSummary: hiddenSummary,
      job: job
        ? {
            status: job.status,
            currentGate: job.currentGate,
            queuedAt: job.queuedAt,
            startedAt: job.startedAt,
            completedAt: job.completedAt,
          }
        : null,
    };
  },
});

export const getByIdInternal = internalQuery({
  args: { verificationId: v.id("verifications") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.verificationId);
  },
});

/**
 * SECURITY (P2-5): Mark running verifications that have exceeded their
 * timeout as failed. Called periodically by cron.
 */
export const timeoutStale = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();

    // Query all running verifications
    const running = await ctx.db
      .query("verifications")
      .withIndex("by_status", (q) => q.eq("status", "running"))
      .collect();

    let timedOutCount = 0;
    for (const v of running) {
      if (!v.startedAt) continue;
      const elapsedMs = now - v.startedAt;
      const timeoutMs = v.timeoutSeconds * 1000;

      // Add a 60s grace period beyond the configured timeout
      if (elapsedMs > timeoutMs + 60_000) {
        await ctx.db.patch(v._id, {
          status: "failed",
          completedAt: now,
          errorLog: `Verification timed out after ${Math.round(elapsedMs / 1000)}s (limit: ${v.timeoutSeconds}s)`,
        });

        // Also fail the submission
        await ctx.db.patch(v.submissionId, { status: "failed" });
        timedOutCount++;
      }
    }

    // Also check pending verifications stuck for more than 10 minutes
    const pending = await ctx.db
      .query("verifications")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .collect();

    for (const v of pending) {
      const age = now - v._creationTime;
      if (age > 10 * 60 * 1000) {
        await ctx.db.patch(v._id, {
          status: "failed",
          completedAt: now,
          errorLog: "Verification stuck in pending state for >10 minutes",
        });
        await ctx.db.patch(v.submissionId, { status: "failed" });
        timedOutCount++;
      }
    }

    if (timedOutCount > 0) {
      console.log(`Timed out ${timedOutCount} stale verifications`);
    }
  },
});

export const getBySubmissionInternal = internalQuery({
  args: { submissionId: v.id("submissions") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("verifications")
      .withIndex("by_submissionId", (q) =>
        q.eq("submissionId", args.submissionId)
      )
      .first();
  },
});

/**
 * After verification passes, trigger payout if bounty uses Stripe escrow.
 */
export const triggerPayoutOnVerificationPass = internalAction({
  args: {
    verificationId: v.id("verifications"),
    bountyId: v.id("bounties"),
    submissionId: v.id("submissions"),
  },
  handler: async (ctx, args) => {
    try {
      // Guard: verify the verification actually passed
      const verification = await ctx.runQuery(internal.verifications.getByIdInternal, {
        verificationId: args.verificationId,
      });
      if (!verification || verification.status !== "passed") {
        console.log(`[payout] Verification ${args.verificationId} is not passed, skipping`);
        return;
      }

      const bounty = await ctx.runQuery(internal.bounties.getByIdInternal, {
        bountyId: args.bountyId,
      });
      if (!bounty) throw new Error("Bounty not found");

      // Only process Stripe payouts for funded escrows
      if (bounty.paymentMethod !== "stripe" || bounty.escrowStatus !== "funded") {
        console.log(
          `[payout] Skipping payout for bounty ${args.bountyId}: method=${bounty.paymentMethod}, escrow=${bounty.escrowStatus}`
        );
        return;
      }

      // Guard: prevent duplicate payment records per bounty
      const existingPayment = await ctx.runQuery(internal.payments.getByBountyInternal, {
        bountyId: args.bountyId,
      });
      if (existingPayment && existingPayment.status !== "failed") {
        console.log(`[payout] Payment already exists for bounty ${args.bountyId}, skipping`);
        return;
      }

      // Get the solver's user ID from the submission
      const submission = await ctx.runQuery(
        internal.submissions.getByIdInternal,
        { submissionId: args.submissionId }
      );
      if (!submission) throw new Error("Submission not found");

      // Initiate payment record
      const paymentId = await ctx.runMutation(internal.payments.initiate, {
        bountyId: args.bountyId,
        recipientId: submission.agentId,
        amount: bounty.reward,
        currency: bounty.rewardCurrency,
        method: "stripe",
      });

      // Release escrow
      await ctx.runAction(internal.stripe.releaseEscrow, {
        bountyId: args.bountyId,
        recipientUserId: submission.agentId,
        paymentId,
      });

      // Mark bounty as completed
      await ctx.runMutation(internal.bounties.updateStatusInternal, {
        bountyId: args.bountyId,
        status: "completed",
      });

      // Mark the active claim as completed (also triggers fork cleanup via P1-3)
      const activeClaim = await ctx.runQuery(internal.bountyClaims.getActiveByClaim, {
        bountyId: args.bountyId,
      });
      if (activeClaim) {
        await ctx.runMutation(internal.bountyClaims.markCompleted, {
          claimId: activeClaim._id,
        });
      }

      console.log(
        `[payout] Escrow released for bounty ${args.bountyId} to user ${submission.agentId}`
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown payout error";
      console.error(
        `[payout] Failed for bounty ${args.bountyId}: ${errorMessage}`
      );
    }
  },
});

/**
 * Main verification entry point.
 * Dispatches the verification job to the external worker service.
 * If the worker is not configured, falls back to a stub.
 */
export const runVerification = internalAction({
  args: {
    verificationId: v.id("verifications"),
    submissionId: v.id("submissions"),
    bountyId: v.id("bounties"),
  },
  handler: async (ctx, args) => {
    const workerUrl = process.env.WORKER_API_URL;

    if (workerUrl) {
      // Dispatch to external worker service
      await ctx.runAction(
        internal.pipelines.dispatchVerification.dispatchVerification,
        {
          verificationId: args.verificationId,
          submissionId: args.submissionId,
          bountyId: args.bountyId,
        }
      );
    } else {
      // Fallback: run stub verification (for development)
      console.warn(
        "[DEV MODE] WORKER_API_URL not configured. Running stub verification."
      );

      await ctx.runMutation(internal.verifications.updateResult, {
        verificationId: args.verificationId,
        status: "running",
        startedAt: Date.now(),
      });

      await ctx.runMutation(internal.submissions.updateStatus, {
        submissionId: args.submissionId,
        status: "running",
      });

      // Simulate a brief delay
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Record stub sanity gates
      await ctx.runMutation(internal.sanityGates.record, {
        verificationId: args.verificationId,
        gateType: "build",
        tool: "npm ci",
        status: "passed",
      });

      await ctx.runMutation(internal.sanityGates.record, {
        verificationId: args.verificationId,
        gateType: "lint",
        tool: "eslint",
        status: "passed",
      });

      await ctx.runMutation(internal.sanityGates.record, {
        verificationId: args.verificationId,
        gateType: "typecheck",
        tool: "tsc",
        status: "passed",
      });

      await ctx.runMutation(internal.sanityGates.record, {
        verificationId: args.verificationId,
        gateType: "security",
        tool: "trivy + semgrep",
        status: "passed",
      });

      // Mark as completed
      await ctx.runMutation(internal.verifications.updateResult, {
        verificationId: args.verificationId,
        status: "passed",
        result: "Stub verification passed (worker not configured)",
        completedAt: Date.now(),
      });

      await ctx.runMutation(internal.submissions.updateStatus, {
        submissionId: args.submissionId,
        status: "passed",
      });

      // Trigger payout
      await ctx.scheduler.runAfter(
        0,
        internal.verifications.triggerPayoutOnVerificationPass,
        {
          verificationId: args.verificationId,
          bountyId: args.bountyId,
          submissionId: args.submissionId,
        }
      );
    }
  },
});
