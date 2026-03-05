import { Router, Request, Response } from "express";
import { Queue } from "bullmq";
import { v4 as uuidv4 } from "uuid";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { logger } from "../index";
import { VerificationJobData } from "../queue/jobQueue";
import { resolveConfiguredConvexHttpActionsUrl } from "../convex/url";
import { execFileAsync } from "../lib/execFileAsync";
import {
  buildAuthenticatedCloneRepoUrl,
  ensureParsedRepoRef,
  parseRepoRef,
  repoRefToPath,
} from "../lib/repoProviderAuth";

/**
 * Request body for POST /api/verify
 */
interface VerifyRequestBody {
  /** Convex submission ID */
  submissionId: string;
  /** Convex bounty ID */
  bountyId: string;
  /** Git repository URL to clone inside the VM */
  repoUrl: string;
  /** Git commit SHA to check out */
  commitSha: string;
  /** Optional short-lived repo access token (GitHub installation token). */
  repoAuthToken?: string;
  /** Optional auth username for providers that use username+token auth (Bitbucket). */
  repoAuthUsername?: string;
  /** Base commit SHA from the bounty's repoConnection for diff-scoped analysis */
  baseCommitSha?: string;
  /** Primary language hint (e.g. "typescript", "python") */
  language?: string;
  /** Optional per-job timeout override in seconds */
  timeoutSeconds?: number;
  /** Convex deployment URL to post results back to */
  convexUrl?: string;
  /** Convex HTTP-actions URL to post results back to (ignored; server-configured only) */
  convexHttpActionsUrl?: string;
  /** Test suites with visibility metadata from Convex */
  testSuites?: Array<{
    id: string;
    title: string;
    gherkinContent: string;
    visibility: "public" | "hidden";
  }>;
  /** Diff patch to apply instead of checking out a specific commit (workspace flow). */
  diffPatch?: string;
  /** Source workspace ID (for tracking). */
  sourceWorkspaceId?: string;
  /** Per-job HMAC token for result verification. */
  jobHmac?: string;
  /** Step definitions for public scenarios. */
  stepDefinitionsPublic?: string;
  /** Step definitions for hidden scenarios. */
  stepDefinitionsHidden?: string;
  /** ZTACO mode: all gates block. */
  ztacoMode?: boolean;
  /** Convex-generated verification ID. */
  verificationId?: string;
  /** Convex-generated job ID. */
  jobId?: string;
}

interface PublishPrRequestBody {
  verificationId: string;
  submissionId: string;
  bountyId: string;
  repoUrl: string;
  repoAuthToken?: string;
  repoAuthUsername?: string;
  baseCommitSha: string;
  baseBranch: string;
  featureBranchName: string;
  diffPatch: string;
  prTitle: string;
  prBody: string;
}

const PUBLISH_PR_REQUIRED_FIELDS: Array<keyof PublishPrRequestBody> = [
  "verificationId",
  "submissionId",
  "bountyId",
  "repoUrl",
  "baseCommitSha",
  "baseBranch",
  "featureBranchName",
  "diffPatch",
  "prTitle",
  "prBody",
  "repoAuthToken",
];

async function runGit(
  args: string[],
  cwd: string,
  redactedToken?: string,
): Promise<void> {
  try {
    await execFileAsync("git", args, { cwd });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
    const stderr = (e.stderr ?? "").trim();
    const stdout = (e.stdout ?? "").trim();
    const combined = [stderr, stdout].filter(Boolean).join("\n");
    const sanitized = redactedToken
      ? combined.split(redactedToken).join("<redacted>")
      : combined;
    throw new Error(`git ${args[0]} failed: ${sanitized.slice(0, 500)}`);
  }
}

interface PublishReviewResponse {
  provider: "github" | "gitlab" | "bitbucket";
  url: string | null;
  id: number | string | null;
}

function buildBitbucketBasicAuth(username: string, token: string): string {
  return "Basic " + Buffer.from(`${username}:${token}`).toString("base64");
}

async function createReviewRequest(
  parsedRepo: ReturnType<typeof ensureParsedRepoRef>,
  body: PublishPrRequestBody,
  repoAuthToken: string,
  repoAuthUsername?: string,
): Promise<PublishReviewResponse> {
  if (parsedRepo.provider === "github") {
    const prResponse = await fetch(
      `https://api.github.com/repos/${parsedRepo.owner}/${parsedRepo.repo}/pulls`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${repoAuthToken}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
          "User-Agent": "arcagent-worker",
        },
        body: JSON.stringify({
          title: body.prTitle,
          head: body.featureBranchName,
          base: body.baseBranch,
          body: body.prBody,
        }),
      },
    );

    if (!prResponse.ok) {
      const payload = await prResponse.text();
      throw new Error(`Failed to create GitHub PR (${prResponse.status}): ${payload.slice(0, 400)}`);
    }

    const payload = (await prResponse.json()) as { html_url?: string; number?: number };
    return {
      provider: "github",
      url: payload.html_url ?? null,
      id: payload.number ?? null,
    };
  }

  if (parsedRepo.provider === "gitlab") {
    const projectId = encodeURIComponent(`${parsedRepo.namespace}/${parsedRepo.repo}`);
    const mrResponse = await fetch(`https://gitlab.com/api/v4/projects/${projectId}/merge_requests`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${repoAuthToken}`,
        "Content-Type": "application/json",
        "User-Agent": "arcagent-worker",
      },
      body: JSON.stringify({
        title: body.prTitle,
        source_branch: body.featureBranchName,
        target_branch: body.baseBranch,
        description: body.prBody,
      }),
    });

    if (!mrResponse.ok) {
      const payload = await mrResponse.text();
      throw new Error(`Failed to create GitLab MR (${mrResponse.status}): ${payload.slice(0, 400)}`);
    }

    const payload = (await mrResponse.json()) as { web_url?: string; iid?: number };
    return {
      provider: "gitlab",
      url: payload.web_url ?? null,
      id: payload.iid ?? null,
    };
  }

  const bitbucketResponse = await fetch(
    `https://api.bitbucket.org/2.0/repositories/${parsedRepo.workspace}/${parsedRepo.repo}/pullrequests`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: repoAuthUsername
          ? buildBitbucketBasicAuth(repoAuthUsername, repoAuthToken)
          : `Bearer ${repoAuthToken}`,
        "Content-Type": "application/json",
        "User-Agent": "arcagent-worker",
      },
      body: JSON.stringify({
        title: body.prTitle,
        description: body.prBody,
        source: {
          branch: { name: body.featureBranchName },
        },
        destination: {
          branch: { name: body.baseBranch },
        },
      }),
    },
  );

  if (!bitbucketResponse.ok) {
    const payload = await bitbucketResponse.text();
    throw new Error(`Failed to create Bitbucket PR (${bitbucketResponse.status}): ${payload.slice(0, 400)}`);
  }

  const payload = (await bitbucketResponse.json()) as {
    id?: number;
    links?: { html?: { href?: string } };
  };
  return {
    provider: "bitbucket",
    url: payload.links?.html?.href ?? null,
    id: payload.id ?? null,
  };
}

function collectMissingPublishPrFields(body: PublishPrRequestBody): string[] {
  const missing: string[] = [];
  for (const field of PUBLISH_PR_REQUIRED_FIELDS) {
    if (!body[field]) {
      missing.push(field);
    }
  }
  return missing;
}

function isValidFeatureBranchName(featureBranchName: string): boolean {
  return /^arcagent\/verified-[a-z0-9]+$/i.test(featureBranchName);
}

/**
 * Creates and returns the Express router with all API route handlers.
 */
export function createRoutes(queue: Queue<VerificationJobData>): Router {
  const router = Router();

  // --------------------------------------------------------------------------
  // POST /api/verify – enqueue a new verification job
  // --------------------------------------------------------------------------
  router.post("/verify", async (req: Request, res: Response) => {
    try {
      const body = req.body as VerifyRequestBody;

      // Validate required fields
      const missing: string[] = [];
      if (!body.submissionId) missing.push("submissionId");
      if (!body.bountyId) missing.push("bountyId");
      if (!body.repoUrl) missing.push("repoUrl");
      if (!body.commitSha) missing.push("commitSha");
      if (!body.jobHmac) missing.push("jobHmac");

      if (missing.length > 0) {
        res.status(400).json({
          error: `Missing required fields: ${missing.join(", ")}`,
        });
        return;
      }

      const jobId = uuidv4();

      // SECURITY (C4): Always use server-configured Convex HTTP-actions URL — never trust
      // client-provided convexUrl/convexHttpActionsUrl, which could point to an attacker.
      const configuredConvexHttpActionsUrl = resolveConfiguredConvexHttpActionsUrl();
      const jobData: VerificationJobData = {
        verificationId: body.verificationId,
        jobId,
        submissionId: body.submissionId,
        bountyId: body.bountyId,
        repoUrl: body.repoUrl,
        repoAuthToken: body.repoAuthToken,
        repoAuthUsername: body.repoAuthUsername,
        commitSha: body.commitSha,
        baseCommitSha: body.baseCommitSha,
        language: body.language,
        timeoutSeconds: Math.max(60, Math.min(body.timeoutSeconds ?? 300, 3600)),
        convexHttpActionsUrl: configuredConvexHttpActionsUrl,
        convexUrl: configuredConvexHttpActionsUrl,
        testSuites: body.testSuites,
        diffPatch: body.diffPatch,
        sourceWorkspaceId: body.sourceWorkspaceId,
        ztacoMode: body.ztacoMode,
        stepDefinitionsPublic: body.stepDefinitionsPublic,
        stepDefinitionsHidden: body.stepDefinitionsHidden,
        jobHmac: body.jobHmac,
      };

      await queue.add("verify", jobData, {
        jobId,
        attempts: 2,
        backoff: { type: "exponential", delay: 5_000 },
        removeOnComplete: { age: 86_400 },  // keep for 24 h
        removeOnFail: { age: 604_800 },     // keep for 7 d
      });

      logger.info("Verification job enqueued", {
        jobId,
        submissionId: body.submissionId,
        bountyId: body.bountyId,
      });

      res.status(202).json({ jobId, status: "queued" });
    } catch (err) {
      logger.error("Failed to enqueue verification job", { error: err });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // --------------------------------------------------------------------------
  // GET /api/status/:id – query the status of a verification job
  // --------------------------------------------------------------------------
  router.get("/status/:id", async (req: Request, res: Response) => {
    try {
      const jobId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const job = await queue.getJob(jobId);

      if (!job) {
        res.status(404).json({ error: "Job not found" });
        return;
      }

      const state = await job.getState();

      // SECURITY: Do not expose job.data — it contains hiddenTestSuites,
      // repo URLs, and other sensitive fields.
      res.json({
        jobId: job.id,
        status: state,
        progress: job.progress,
        failedReason: job.failedReason ?? null,
        timestamps: {
          created: job.timestamp,
          processed: job.processedOn ?? null,
          finished: job.finishedOn ?? null,
        },
      });
    } catch (err) {
      logger.error("Failed to fetch job status", {
        jobId: req.params.id,
        error: err,
      });
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // --------------------------------------------------------------------------
  // POST /api/verify/publish-pr – create feature branch + PR after pass
  // --------------------------------------------------------------------------
  router.post("/verify/publish-pr", async (req: Request, res: Response) => {
    const body = req.body as PublishPrRequestBody;
    const missing = collectMissingPublishPrFields(body);

    if (missing.length > 0) {
      res.status(400).json({ error: `Missing required fields: ${missing.join(", ")}` });
      return;
    }

    if (!isValidFeatureBranchName(body.featureBranchName)) {
      res.status(400).json({
        error: "featureBranchName must match arcagent/verified-<id>",
      });
      return;
    }

    const repoAuthToken = body.repoAuthToken as string;

    const workRoot = await mkdtemp(join(tmpdir(), "arcagent-pr-"));
    const repoDir = join(workRoot, "repo");
    const patchPath = join(workRoot, "submission.patch");

    try {
      const parsed = ensureParsedRepoRef(body.repoUrl);
      const cloneRepo = buildAuthenticatedCloneRepoUrl(
        body.repoUrl,
        repoAuthToken,
        body.repoAuthUsername,
      );
      await runGit(["clone", "--no-tags", "--depth", "1", cloneRepo.url, repoDir], workRoot, repoAuthToken);
      await runGit(["fetch", "--depth", "1", "origin", body.baseCommitSha], repoDir, repoAuthToken);
      await runGit(["checkout", "-B", body.featureBranchName, body.baseCommitSha], repoDir, repoAuthToken);
      await writeFile(patchPath, body.diffPatch, "utf8");
      await runGit(["apply", "--whitespace=fix", patchPath], repoDir, repoAuthToken);
      await runGit(["add", "-A"], repoDir, repoAuthToken);

      // Fail fast when patch applies but produces no net changes.
      const diffCheck = await execFileAsync("git", ["diff", "--cached", "--quiet"], { cwd: repoDir }).then(
        () => "no_changes",
        () => "has_changes",
      );
      if (diffCheck === "no_changes") {
        res.status(409).json({ error: "No staged changes after applying diff; skipping PR creation" });
        return;
      }

      await runGit(
        ["config", "user.name", process.env.GITHUB_BOT_NAME ?? "arcagent-bot"],
        repoDir,
        repoAuthToken,
      );
      await runGit(
        ["config", "user.email", process.env.GITHUB_BOT_EMAIL ?? "bot@arcagent.local"],
        repoDir,
        repoAuthToken,
      );
      await runGit(
        ["commit", "-m", `arcagent: verified submission ${body.submissionId}`],
        repoDir,
        repoAuthToken,
      );
      await runGit(["remote", "set-url", "--push", "origin", cloneRepo.url], repoDir, repoAuthToken);
      await runGit(
        ["push", "origin", `${body.featureBranchName}:${body.featureBranchName}`],
        repoDir,
        repoAuthToken,
      );

      const review = await createReviewRequest(parsed, body, repoAuthToken, body.repoAuthUsername);
      res.status(201).json({
        success: true,
        provider: review.provider,
        featureBranchName: body.featureBranchName,
        featureBranchRepo: repoRefToPath(parsed),
        reviewUrl: review.url,
        reviewId: review.id,
        // Backward-compat fields expected by existing Convex flow.
        pullRequestUrl: review.url,
        pullRequestNumber: review.id,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isClientError =
        message.includes("Unsupported repository URL") ||
        message.includes("Invalid repoAuthToken") ||
        message.includes("Invalid repoAuthUsername");
      logger.error("Failed to publish verification PR", {
        verificationId: body.verificationId,
        submissionId: body.submissionId,
        bountyId: body.bountyId,
        error: message,
      });
      res.status(isClientError ? 400 : 500).json({
        error: message || "Failed to publish PR",
      });
    } finally {
      await rm(workRoot, { recursive: true, force: true }).catch(() => {});
    }
  });

  return router;
}
