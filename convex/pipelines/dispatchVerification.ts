import { internalAction } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { generateJobHmac } from "../lib/hmac";
import { parseGitHubRepoUrlSafe } from "../lib/githubApp";
import { fetchWithRetry } from "../lib/httpRetry";
import { requiresCloneAuthToken, resolveRepoAuth } from "../lib/repoAuth";
import { detectProvider } from "../lib/repoProviders";

type RepoAuthResult = Awaited<ReturnType<typeof resolveRepoAuth>>;

type RepoConnectionRecord = {
  _id: string;
  owner: string;
  repo: string;
  githubInstallationId?: number;
  githubInstallationAccountLogin?: string;
  commitSha?: string;
  dockerfileContent?: string;
  dockerfilePath?: string;
} | null;

type BountyRecord = {
  creatorId: string;
  ztacoMode?: boolean;
} | null;

type DispatchContext = {
  runMutation: (mutation: unknown, args: Record<string, unknown>) => Promise<unknown>;
  runQuery: (query: unknown, args: Record<string, unknown>) => Promise<unknown>;
};

function resolveWorkerConfiguration(
  workerHost: string | undefined,
  workerAuthToken: string | undefined,
): { workerUrl: string; workerSecret: string } {
  const workerUrl = workerHost ?? process.env.WORKER_API_URL;
  const workerSecret = workerAuthToken ?? process.env.WORKER_SHARED_SECRET;
  if (!workerUrl || !workerSecret) {
    throw new Error("WORKER_API_URL and WORKER_SHARED_SECRET must be configured");
  }
  return { workerUrl, workerSecret };
}

function toErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

async function createVerificationJob(
  ctx: DispatchContext,
  args: { verificationId: string; bountyId: string; submissionId: string },
  workerUrl: string,
): Promise<string> {
  return await ctx.runMutation(
    internal.verificationJobs.create,
    {
      verificationId: args.verificationId,
      bountyId: args.bountyId,
      submissionId: args.submissionId,
      workerHostUsed: workerUrl,
    },
  ) as string;
}

async function markDispatchStarted(
  ctx: DispatchContext,
  args: { verificationId: string; submissionId: string },
): Promise<void> {
  await ctx.runMutation(internal.verifications.updateResult, {
    verificationId: args.verificationId,
    status: "running",
    startedAt: Date.now(),
  });
  await ctx.runMutation(internal.submissions.updateStatus, {
    submissionId: args.submissionId,
    status: "running",
  });
}

async function markDispatchFailed(
  ctx: DispatchContext,
  args: { verificationId: string; submissionId: string },
  errorMessage: string,
): Promise<void> {
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

async function resolveProviderAuthConnection(
  ctx: DispatchContext,
  repositoryUrl: string,
  bounty: BountyRecord,
): Promise<{ accessToken?: string } | null> {
  if (!bounty) return null;
  const providerName = detectProvider(repositoryUrl);
  if (!providerName || providerName === "github") return null;
  return await ctx.runQuery(internal.providerConnections.getActiveAuthByUserAndProviderInternal, {
    userId: bounty.creatorId,
    provider: providerName,
  }) as { accessToken?: string } | null;
}

async function resolveRepoAuthForDispatch(params: {
  ctx: DispatchContext;
  repositoryUrl: string;
  repoConnection: RepoConnectionRecord;
  bounty: BountyRecord;
  logPrefix: string;
}): Promise<RepoAuthResult | null> {
  const providerAuthConnection = await resolveProviderAuthConnection(
    params.ctx,
    params.repositoryUrl,
    params.bounty,
  );
  let repoAuthResult: RepoAuthResult | null = null;
  try {
    repoAuthResult = await resolveRepoAuth({
      repositoryUrl: params.repositoryUrl,
      preferredGitHubInstallationId: params.repoConnection?.githubInstallationId,
      writeAccess: false,
      providerToken: providerAuthConnection?.accessToken,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[${params.logPrefix}] Failed to resolve repo token for ${params.repositoryUrl}: ${message}`,
    );
  }

  if (requiresCloneAuthToken(params.repositoryUrl) && !repoAuthResult?.repoAuthToken) {
    throw new Error(
      "GitHub installation token is required for verification clone. Install/repair the GitHub App for this repository.",
    );
  }
  return repoAuthResult;
}

async function syncRepoConnectionInstallationForSubmission(
  ctx: DispatchContext,
  repoConnection: RepoConnectionRecord,
  repoAuthResult: RepoAuthResult | null,
  repositoryUrl: string,
): Promise<void> {
  if (!repoConnection || !repoAuthResult?.installationId) return;
  const submissionRepo = parseGitHubRepoUrlSafe(repositoryUrl);
  if (!submissionRepo) return;
  const matchesConnection =
    submissionRepo.owner.toLowerCase() === repoConnection.owner.toLowerCase() &&
    submissionRepo.repo.toLowerCase() === repoConnection.repo.toLowerCase();
  if (!matchesConnection) return;
  const unchanged =
    repoAuthResult.installationId === repoConnection.githubInstallationId &&
    repoAuthResult.accountLogin === repoConnection.githubInstallationAccountLogin;
  if (unchanged) return;

  await ctx.runMutation(internal.repoConnections.updateGitHubInstallation, {
    repoConnectionId: repoConnection._id,
    githubInstallationId: repoAuthResult.installationId,
    githubInstallationAccountLogin: repoAuthResult.accountLogin,
  });
}

async function syncRepoConnectionInstallation(
  ctx: DispatchContext,
  repoConnection: RepoConnectionRecord,
  repoAuthResult: RepoAuthResult | null,
): Promise<void> {
  if (!repoConnection || !repoAuthResult?.installationId) return;
  const unchanged =
    repoAuthResult.installationId === repoConnection.githubInstallationId &&
    repoAuthResult.accountLogin === repoConnection.githubInstallationAccountLogin;
  if (unchanged) return;
  await ctx.runMutation(internal.repoConnections.updateGitHubInstallation, {
    repoConnectionId: repoConnection._id,
    githubInstallationId: repoAuthResult.installationId,
    githubInstallationAccountLogin: repoAuthResult.accountLogin,
  });
}

async function ensureWorkerDispatchSuccess(response: Response): Promise<void> {
  if (response.ok) return;
  const errorText = await response.text();
  throw new Error(`Worker API error: ${response.status} ${response.statusText} - ${errorText}`);
}

async function persistWorkerJobId(
  ctx: DispatchContext,
  jobId: string,
  result: unknown,
): Promise<void> {
  const workerJobId =
    typeof result === "object" && result !== null && "jobId" in result
      ? String((result as { jobId: unknown }).jobId)
      : "";
  if (!workerJobId) return;
  await ctx.runMutation(internal.verificationJobs.updateWorkerJobId, {
    jobId,
    workerJobId,
  });
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
    workerHost: v.optional(v.string()),
    workerAuthToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    try {
      const { workerUrl, workerSecret } = resolveWorkerConfiguration(args.workerHost, args.workerAuthToken);

      // Create a verificationJob record
      const jobId = await createVerificationJob(
        ctx,
        {
          verificationId: args.verificationId,
          bountyId: args.bountyId,
          submissionId: args.submissionId,
        },
        workerUrl,
      );

      // Mark verification as running
      await markDispatchStarted(ctx, {
        verificationId: args.verificationId,
        submissionId: args.submissionId,
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

      // Fetch generated step definitions (for injection into VM at test time)
      const generatedTests = await ctx.runQuery(
        internal.generatedTests.getByBountyIdInternal,
        { bountyId: args.bountyId }
      );
      const stepDefinitionsPublic = generatedTests?.stepDefinitionsPublic ?? generatedTests?.stepDefinitions;
      const stepDefinitionsHidden = generatedTests?.stepDefinitionsHidden;

      const repoAuthResult = await resolveRepoAuthForDispatch({
        ctx,
        repositoryUrl: submission.repositoryUrl,
        repoConnection,
        bounty,
        logPrefix: "dispatchVerification",
      });
      await syncRepoConnectionInstallationForSubmission(
        ctx,
        repoConnection,
        repoAuthResult,
        submission.repositoryUrl,
      );

      // SECURITY (H6): Generate per-job HMAC token
      const jobHmac = await generateJobHmac(
        args.verificationId,
        args.submissionId,
        args.bountyId,
      );

      // Dispatch to worker
      const convexHttpActionsUrl = process.env.CONVEX_HTTP_ACTIONS_URL ?? process.env.CONVEX_URL;
      const response = await fetchWithRetry(`${workerUrl}/api/verify`, {
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
          repoAuthToken: repoAuthResult?.repoAuthToken,
          repoAuthUsername: repoAuthResult?.repoAuthUsername,
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
          // Step definitions for VM-only injection (agents never see these)
          stepDefinitionsPublic: stepDefinitionsPublic ?? undefined,
          stepDefinitionsHidden: stepDefinitionsHidden ?? undefined,
          // ZTACO mode: all gates block
          ztacoMode: bounty?.ztacoMode ?? false,
        }),
      });

      await ensureWorkerDispatchSuccess(response);
      const result = await response.json();
      await persistWorkerJobId(ctx, jobId, result);
    } catch (error) {
      const errorMessage = toErrorMessage(error, "Unknown error dispatching verification");
      console.error(`dispatchVerification failed: ${errorMessage}`);

      await markDispatchFailed(ctx, {
        verificationId: args.verificationId,
        submissionId: args.submissionId,
      }, errorMessage);
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
  },
  handler: async (ctx, args) => {
    try {
      const { workerUrl, workerSecret } = resolveWorkerConfiguration(args.workerHost, args.workerAuthToken);

      // Create a verificationJob record
      const jobId = await createVerificationJob(
        ctx,
        {
          verificationId: args.verificationId,
          bountyId: args.bountyId,
          submissionId: args.submissionId,
        },
        workerUrl,
      );

      // Mark verification as running
      await markDispatchStarted(ctx, {
        verificationId: args.verificationId,
        submissionId: args.submissionId,
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

      // Fetch generated step definitions
      const generatedTests = await ctx.runQuery(
        internal.generatedTests.getByBountyIdInternal,
        { bountyId: args.bountyId },
      );
      const stepDefinitionsPublic = generatedTests?.stepDefinitionsPublic ?? generatedTests?.stepDefinitions;
      const stepDefinitionsHidden = generatedTests?.stepDefinitionsHidden;

      const repoAuthResult = await resolveRepoAuthForDispatch({
        ctx,
        repositoryUrl: args.baseRepoUrl,
        repoConnection,
        bounty,
        logPrefix: "dispatchVerificationFromDiff",
      });
      await syncRepoConnectionInstallation(ctx, repoConnection, repoAuthResult);

      // SECURITY (H6): Generate per-job HMAC token
      const jobHmac = await generateJobHmac(
        args.verificationId,
        args.submissionId,
        args.bountyId,
      );

      // Dispatch to worker with diff payload
      const convexHttpActionsUrl = process.env.CONVEX_HTTP_ACTIONS_URL ?? process.env.CONVEX_URL;
      const response = await fetchWithRetry(`${workerUrl}/api/verify`, {
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
          repoAuthToken: repoAuthResult?.repoAuthToken,
          repoAuthUsername: repoAuthResult?.repoAuthUsername,
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
          stepDefinitionsPublic: stepDefinitionsPublic ?? undefined,
          stepDefinitionsHidden: stepDefinitionsHidden ?? undefined,
          ztacoMode: bounty?.ztacoMode ?? false,
        }),
      });

      await ensureWorkerDispatchSuccess(response);
      const result = await response.json();
      await persistWorkerJobId(ctx, jobId, result);
    } catch (error) {
      const errorMessage = toErrorMessage(error, "Unknown error dispatching diff verification");
      console.error(`dispatchVerificationFromDiff failed: ${errorMessage}`);

      await markDispatchFailed(ctx, {
        verificationId: args.verificationId,
        submissionId: args.submissionId,
      }, errorMessage);
    }
  },
});
