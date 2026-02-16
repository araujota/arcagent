import { internalAction } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { Id } from "../_generated/dataModel";

/**
 * SECURITY (H6): Generate a per-job HMAC token that must be presented
 * when posting verification results. This prevents a compromised worker
 * secret from being used to forge results for arbitrary submissions.
 */
async function generateJobHmac(
  verificationId: string,
  submissionId: string,
  bountyId: string,
): Promise<string> {
  const secret = process.env.WORKER_SHARED_SECRET || process.env.WORKER_API_SECRET || "";
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const data = `${verificationId}:${submissionId}:${bountyId}`;
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Dispatch a verification job to the worker service.
 * Creates a verificationJob record and sends the job to the external worker.
 */
export const dispatchVerification = internalAction({
  args: {
    verificationId: v.id("verifications"),
    submissionId: v.id("submissions"),
    bountyId: v.id("bounties"),
  },
  handler: async (ctx, args) => {
    try {
      const workerUrl = process.env.WORKER_API_URL;
      const workerSecret = process.env.WORKER_API_SECRET;

      if (!workerUrl || !workerSecret) {
        throw new Error(
          "WORKER_API_URL and WORKER_API_SECRET must be configured"
        );
      }

      // Create a verificationJob record
      const jobId = await ctx.runMutation(
        internal.verificationJobs.create,
        {
          verificationId: args.verificationId,
          bountyId: args.bountyId,
          submissionId: args.submissionId,
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
          repositoryUrl: submission.repositoryUrl,
          commitHash: submission.commitHash,
          baseCommitSha: repoConnection?.commitSha,
          testSuites: testSuites.map((ts) => ({
            id: ts._id,
            title: ts.title,
            gherkinContent: ts.gherkinContent,
            visibility: ts.visibility,
          })),
          dockerfileContent: repoConnection?.dockerfileContent,
          dockerfilePath: repoConnection?.dockerfilePath,
          convexUrl: process.env.CONVEX_URL,
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
      if (result.workerJobId) {
        await ctx.runMutation(internal.verificationJobs.updateWorkerJobId, {
          jobId,
          workerJobId: result.workerJobId,
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
  },
  handler: async (ctx, args) => {
    try {
      const workerUrl = process.env.WORKER_API_URL;
      const workerSecret = process.env.WORKER_API_SECRET;

      if (!workerUrl || !workerSecret) {
        throw new Error(
          "WORKER_API_URL and WORKER_API_SECRET must be configured",
        );
      }

      // Create a verificationJob record
      const jobId = await ctx.runMutation(
        internal.verificationJobs.create,
        {
          verificationId: args.verificationId,
          bountyId: args.bountyId,
          submissionId: args.submissionId,
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
          repositoryUrl: args.baseRepoUrl,
          commitHash: args.baseCommitSha,
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
          convexUrl: process.env.CONVEX_URL,
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

      if (result.workerJobId) {
        await ctx.runMutation(internal.verificationJobs.updateWorkerJobId, {
          jobId,
          workerJobId: result.workerJobId,
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
