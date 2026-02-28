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
  /** Creator's gate settings — gates can be individually disabled. */
  gateSettings?: {
    snykEnabled?: boolean;
    sonarqubeEnabled?: boolean;
  };
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
  baseCommitSha: string;
  baseBranch: string;
  featureBranchName: string;
  diffPatch: string;
  prTitle: string;
  prBody: string;
}

function parseGitHubRepo(repoUrl: string): { owner: string; repo: string } | null {
  const match = repoUrl.match(/^(?:https?:\/\/github\.com\/|git@github\.com:)([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

function buildGitHubAuthCloneUrl(repoUrl: string, githubToken?: string): string {
  if (!githubToken) return repoUrl;
  const parsed = parseGitHubRepo(repoUrl);
  if (!parsed) return repoUrl;
  if (!/^[A-Za-z0-9_-]+$/.test(githubToken)) {
    throw new Error("Invalid repoAuthToken format");
  }
  return `https://x-access-token:${githubToken}@github.com/${parsed.owner}/${parsed.repo}.git`;
}

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
      // SECURITY (M5): Only accept gateSettings from internal Convex data,
      // not from the request body.
      const configuredConvexHttpActionsUrl = resolveConfiguredConvexHttpActionsUrl();
      const jobData: VerificationJobData = {
        jobId,
        submissionId: body.submissionId,
        bountyId: body.bountyId,
        repoUrl: body.repoUrl,
        repoAuthToken: body.repoAuthToken,
        commitSha: body.commitSha,
        baseCommitSha: body.baseCommitSha,
        language: body.language,
        timeoutSeconds: Math.max(60, Math.min(body.timeoutSeconds ?? 300, 3600)),
        convexHttpActionsUrl: configuredConvexHttpActionsUrl,
        convexUrl: configuredConvexHttpActionsUrl,
        testSuites: body.testSuites,
        gateSettings: body.gateSettings,
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
    const missing: string[] = [];
    if (!body.verificationId) missing.push("verificationId");
    if (!body.submissionId) missing.push("submissionId");
    if (!body.bountyId) missing.push("bountyId");
    if (!body.repoUrl) missing.push("repoUrl");
    if (!body.baseCommitSha) missing.push("baseCommitSha");
    if (!body.baseBranch) missing.push("baseBranch");
    if (!body.featureBranchName) missing.push("featureBranchName");
    if (!body.diffPatch) missing.push("diffPatch");
    if (!body.prTitle) missing.push("prTitle");
    if (!body.prBody) missing.push("prBody");
    if (!body.repoAuthToken) missing.push("repoAuthToken");

    if (missing.length > 0) {
      res.status(400).json({ error: `Missing required fields: ${missing.join(", ")}` });
      return;
    }

    if (!/^arcagent\/verified-[a-z0-9]+$/i.test(body.featureBranchName)) {
      res.status(400).json({
        error: "featureBranchName must match arcagent/verified-<id>",
      });
      return;
    }

    const githubToken = body.repoAuthToken;
    if (!githubToken) {
      res.status(400).json({ error: "Missing required fields: repoAuthToken" });
      return;
    }

    const parsed = parseGitHubRepo(body.repoUrl);
    if (!parsed) {
      res.status(400).json({ error: "Only GitHub repository URLs are supported for auto PR publish" });
      return;
    }

    const workRoot = await mkdtemp(join(tmpdir(), "arcagent-pr-"));
    const repoDir = join(workRoot, "repo");
    const patchPath = join(workRoot, "submission.patch");

    try {
      const cloneUrl = buildGitHubAuthCloneUrl(body.repoUrl, githubToken);
      const pushUrl = `https://x-access-token:${githubToken}@github.com/${parsed.owner}/${parsed.repo}.git`;
      await runGit(["clone", "--no-tags", "--depth", "1", cloneUrl, repoDir], workRoot, githubToken);
      await runGit(["fetch", "--depth", "1", "origin", body.baseCommitSha], repoDir, githubToken);
      await runGit(["checkout", "-B", body.featureBranchName, body.baseCommitSha], repoDir, githubToken);
      await writeFile(patchPath, body.diffPatch, "utf8");
      await runGit(["apply", "--whitespace=fix", patchPath], repoDir, githubToken);
      await runGit(["add", "-A"], repoDir, githubToken);

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
        githubToken,
      );
      await runGit(
        ["config", "user.email", process.env.GITHUB_BOT_EMAIL ?? "bot@arcagent.local"],
        repoDir,
        githubToken,
      );
      await runGit(
        ["commit", "-m", `arcagent: verified submission ${body.submissionId}`],
        repoDir,
        githubToken,
      );
      await runGit(["remote", "set-url", "--push", "origin", pushUrl], repoDir, githubToken);
      await runGit(
        ["push", "origin", `${body.featureBranchName}:${body.featureBranchName}`],
        repoDir,
        githubToken,
      );

      const prResponse = await fetch(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}/pulls`, {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${githubToken}`,
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
      });

      if (!prResponse.ok) {
        const payload = await prResponse.text();
        throw new Error(
          `Failed to create PR (${prResponse.status}): ${payload.slice(0, 400)}`,
        );
      }

      const prPayload = await prResponse.json() as { html_url?: string; number?: number };
      res.status(201).json({
        success: true,
        featureBranchName: body.featureBranchName,
        featureBranchRepo: `${parsed.owner}/${parsed.repo}`,
        pullRequestUrl: prPayload.html_url ?? null,
        pullRequestNumber: prPayload.number ?? null,
      });
    } catch (err) {
      logger.error("Failed to publish verification PR", {
        verificationId: body.verificationId,
        submissionId: body.submissionId,
        bountyId: body.bountyId,
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({
        error: err instanceof Error ? err.message : "Failed to publish PR",
      });
    } finally {
      await rm(workRoot, { recursive: true, force: true }).catch(() => {});
    }
  });

  return router;
}
