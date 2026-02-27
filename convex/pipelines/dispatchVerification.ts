import { internalAction } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { Id } from "../_generated/dataModel";
import { generateJobHmac } from "../lib/hmac";

/**
 * Dispatch a verification job to the worker service.
 * Creates a verificationJob record and sends the job to the external worker.
 */
export const dispatchVerification = internalAction({
  args: {
    verificationId: v.id("verifications"),
    submissionId: v.id("submissions"),
    bountyId: v.id("bounties"),
    workerHost: v.optional(v.string()),
    workerAuthToken: v.optional(v.string()),
    attemptWorkerId: v.optional(v.id("attemptWorkers")),
  },
  handler: async (ctx, args) => {
    try {
      const workerUrl = args.workerHost ?? process.env.WORKER_API_URL;
      const workerSecret = args.workerAuthToken ?? process.env.WORKER_SHARED_SECRET;

      if (!workerUrl || !workerSecret) {
        throw new Error(
          "WORKER_API_URL and WORKER_SHARED_SECRET must be configured"
        );
      }

      // Create a verificationJob record
      const jobId = await ctx.runMutation(
        internal.verificationJobs.create,
        {
          verificationId: args.verificationId,
          bountyId: args.bountyId,
          submissionId: args.submissionId,
          workerHostUsed: workerUrl,
          attemptWorkerId: args.attemptWorkerId,
        }
      );

      // Mark verification as running
      await ctx.runMutation(internal.verifications.updateResult, {
        verificationId: args.verificationId,
        status: "running",
        startedAt: Date.now(),
      });

      await ctx.runMutation(internal.submissions.updateStatus, {
        submissionId: args.submissionId,
        status: "running",
      });

      // Get submission details
      const submission = await ctx.runQuery(internal.submissions.getByIdInternal, {
        submissionId: args.submissionId,
      });

      if (!submission) {
        throw new Error("Submission not found");
      }

      // Get test suites for this bounty
      const testSuites = await ctx.runQuery(internal.testSuites.listAllByBounty, {
        bountyId: args.bountyId,
      });

      // Get repo connection for Dockerfile
      const repoConnection = await ctx.runQuery(
        internal.repoConnections.getByBountyIdInternal,
        { bountyId: args.bountyId }
      );

      // Fetch bounty creator's gate settings
      const bounty = await ctx.runQuery(internal.bounties.getByIdInternal, {
        bountyId: args.bountyId,
      });
      const creator = bounty
        ? await ctx.runQuery(internal.users.getByIdInternal, {
            userId: bounty.creatorId,
          })
        : null;

      // Fetch generated step definitions (for injection into VM at test time)
      const generatedTests = await ctx.runQuery(
        internal.generatedTests.getByBountyIdInternal,
        { bountyId: args.bountyId }
      );
      const stepDefinitionsPublic = generatedTests?.stepDefinitionsPublic ?? generatedTests?.stepDefinitions;
      const stepDefinitionsHidden = generatedTests?.stepDefinitionsHidden;

      // SECURITY (H6): Generate per-job HMAC token
      const jobHmac = await generateJobHmac(
        args.verificationId,
        args.submissionId,
        args.bountyId,
      );

      // Dispatch to worker
      const convexHttpActionsUrl = process.env.CONVEX_HTTP_ACTIONS_URL ?? process.env.CONVEX_URL;
      const response = await fetch(`${workerUrl}/api/verify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${workerSecret}`,
        },
        body: JSON.stringify({
          verificationId: args.verificationId,
          submissionId: args.submissionId,
          bountyId: args.bountyId,
          jobId,
          repoUrl: submission.repositoryUrl,
          commitSha: submission.commitHash,
          baseCommitSha: repoConnection?.commitSha,
          testSuites: testSuites.map((ts) => ({
            id: ts._id,
            title: ts.title,
            gherkinContent: ts.gherkinContent,
            visibility: ts.visibility,
          })),
          dockerfileContent: repoConnection?.dockerfileContent,
          dockerfilePath: repoConnection?.dockerfilePath,
          convexHttpActionsUrl,
          convexUrl: convexHttpActionsUrl,
          jobHmac,
          gateSettings: {
            snykEnabled: creator?.gateSettings?.snykEnabled ?? true,
            sonarqubeEnabled: creator?.gateSettings?.sonarqubeEnabled ?? true,
          },
          // Step definitions for VM-only injection (agents never see these)
          stepDefinitionsPublic: stepDefinitionsPublic ?? undefined,
          stepDefinitionsHidden: stepDefinitionsHidden ?? undefined,
          // ZTACO mode: all gates block
          ztacoMode: bounty?.ztacoMode ?? false,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Worker API error: ${response.status} ${response.statusText} - ${errorText}`
        );
      }

      const result = await response.json();

      // Update job with worker-assigned ID
      if (result.jobId) {
        await ctx.runMutation(internal.verificationJobs.updateWorkerJobId, {
          jobId,
          workerJobId: result.jobId,
        });
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : "Unknown error dispatching verification";
      console.error(`dispatchVerification failed: ${errorMessage}`);

      // Mark as failed
      await ctx.runMutation(internal.verifications.updateResult, {
        verificationId: args.verificationId,
        status: "failed",
        errorLog: errorMessage,
        completedAt: Date.now(),
      });

      await ctx.runMutation(internal.submissions.updateStatus, {
        submissionId: args.submissionId,
        status: "failed",
      });
    }
  },
});

/**
 * Dispatch a diff-based verification job to the worker service.
 * Instead of a repositoryUrl + commitHash, sends the base repo info
 * plus a unified diff patch to apply on a clean clone.
 */
export const dispatchVerificationFromDiff = internalAction({
  args: {
    verificationId: v.id("verifications"),
    submissionId: v.id("submissions"),
    bountyId: v.id("bounties"),
    baseRepoUrl: v.string(),
    baseCommitSha: v.string(),
    diffPatch: v.string(),
    sourceWorkspaceId: v.string(),
    workerHost: v.optional(v.string()),
    workerAuthToken: v.optional(v.string()),
    attemptWorkerId: v.optional(v.id("attemptWorkers")),
  },
  handler: async (ctx, args) => {
    try {
      const workerUrl = args.workerHost ?? process.env.WORKER_API_URL;
      const workerSecret = args.workerAuthToken ?? process.env.WORKER_SHARED_SECRET;

      if (!workerUrl || !workerSecret) {
        throw new Error(
          "WORKER_API_URL and WORKER_SHARED_SECRET must be configured",
        );
      }

      // Create a verificationJob record
      const jobId = await ctx.runMutation(
        internal.verificationJobs.create,
        {
          verificationId: args.verificationId,
          bountyId: args.bountyId,
          submissionId: args.submissionId,
          workerHostUsed: workerUrl,
          attemptWorkerId: args.attemptWorkerId,
        },
      );

      // Mark verification as running
      await ctx.runMutation(internal.verifications.updateResult, {
        verificationId: args.verificationId,
        status: "running",
        startedAt: Date.now(),
      });

      await ctx.runMutation(internal.submissions.updateStatus, {
        submissionId: args.submissionId,
        status: "running",
      });

      // Get test suites for this bounty
      const testSuites = await ctx.runQuery(internal.testSuites.listAllByBounty, {
        bountyId: args.bountyId,
      });

      // Get repo connection for Dockerfile
      const repoConnection = await ctx.runQuery(
        internal.repoConnections.getByBountyIdInternal,
        { bountyId: args.bountyId },
      );

      // Fetch bounty creator's gate settings
      const bounty = await ctx.runQuery(internal.bounties.getByIdInternal, {
        bountyId: args.bountyId,
      });
      const creator = bounty
        ? await ctx.runQuery(internal.users.getByIdInternal, {
            userId: bounty.creatorId,
          })
        : null;

      // Fetch generated step definitions
      const generatedTests = await ctx.runQuery(
        internal.generatedTests.getByBountyIdInternal,
        { bountyId: args.bountyId },
      );
      const stepDefinitionsPublic = generatedTests?.stepDefinitionsPublic ?? generatedTests?.stepDefinitions;
      const stepDefinitionsHidden = generatedTests?.stepDefinitionsHidden;

      // SECURITY (H6): Generate per-job HMAC token
      const jobHmac = await generateJobHmac(
        args.verificationId,
        args.submissionId,
        args.bountyId,
      );

      // Dispatch to worker with diff payload
      const convexHttpActionsUrl = process.env.CONVEX_HTTP_ACTIONS_URL ?? process.env.CONVEX_URL;
      const response = await fetch(`${workerUrl}/api/verify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${workerSecret}`,
        },
        body: JSON.stringify({
          verificationId: args.verificationId,
          submissionId: args.submissionId,
          bountyId: args.bountyId,
          jobId,
          // Diff-based fields
          repoUrl: args.baseRepoUrl,
          commitSha: args.baseCommitSha,
          baseCommitSha: args.baseCommitSha,
          diffPatch: args.diffPatch,
          sourceWorkspaceId: args.sourceWorkspaceId,
          // Standard fields
          testSuites: testSuites.map((ts) => ({
            id: ts._id,
            title: ts.title,
            gherkinContent: ts.gherkinContent,
            visibility: ts.visibility,
          })),
          dockerfileContent: repoConnection?.dockerfileContent,
          dockerfilePath: repoConnection?.dockerfilePath,
          convexHttpActionsUrl,
          convexUrl: convexHttpActionsUrl,
          jobHmac,
          gateSettings: {
            snykEnabled: creator?.gateSettings?.snykEnabled ?? true,
            sonarqubeEnabled: creator?.gateSettings?.sonarqubeEnabled ?? true,
          },
          stepDefinitionsPublic: stepDefinitionsPublic ?? undefined,
          stepDefinitionsHidden: stepDefinitionsHidden ?? undefined,
          ztacoMode: bounty?.ztacoMode ?? false,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Worker API error: ${response.status} ${response.statusText} - ${errorText}`,
        );
      }

      const result = await response.json();

      if (result.jobId) {
        await ctx.runMutation(internal.verificationJobs.updateWorkerJobId, {
          jobId,
          workerJobId: result.jobId,
        });
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : "Unknown error dispatching diff verification";
      console.error(`dispatchVerificationFromDiff failed: ${errorMessage}`);

      await ctx.runMutation(internal.verifications.updateResult, {
        verificationId: args.verificationId,
        status: "failed",
        errorLog: errorMessage,
        completedAt: Date.now(),
      });

      await ctx.runMutation(internal.submissions.updateStatus, {
        submissionId: args.submissionId,
        status: "failed",
      });
    }
  },
});
