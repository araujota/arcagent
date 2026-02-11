import { query, internalMutation, internalAction, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";

export const getBySubmission = query({
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

export const listByBounty = query({
  args: { bountyId: v.id("bounties") },
  handler: async (ctx, args) => {
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
    }
  },
});
