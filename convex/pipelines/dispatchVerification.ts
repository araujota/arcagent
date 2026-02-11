import { internalAction } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";

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
          testSuites: testSuites.map((ts) => ({
            id: ts._id,
            title: ts.title,
            gherkinContent: ts.gherkinContent,
            visibility: ts.visibility,
          })),
          dockerfileContent: repoConnection?.dockerfileContent,
          dockerfilePath: repoConnection?.dockerfilePath,
          convexUrl: process.env.CONVEX_URL,
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
