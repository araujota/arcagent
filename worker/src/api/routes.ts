import { Router, Request, Response } from "express";
import { Queue } from "bullmq";
import { v4 as uuidv4 } from "uuid";
import { logger } from "../index";
import { VerificationJobData } from "../queue/jobQueue";

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
  /** Base commit SHA from the bounty's repoConnection for diff-scoped analysis */
  baseCommitSha?: string;
  /** Primary language hint (e.g. "typescript", "python") */
  language?: string;
  /** Optional per-job timeout override in seconds */
  timeoutSeconds?: number;
  /** Convex deployment URL to post results back to */
  convexUrl?: string;
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

      if (missing.length > 0) {
        res.status(400).json({
          error: `Missing required fields: ${missing.join(", ")}`,
        });
        return;
      }

      const jobId = uuidv4();

      // SECURITY (C4): Always use server-configured CONVEX_URL — never trust
      // client-provided convexUrl, which could point to an attacker's server.
      // SECURITY (M5): Only accept gateSettings from internal Convex data,
      // not from the request body.
      const jobData: VerificationJobData = {
        jobId,
        submissionId: body.submissionId,
        bountyId: body.bountyId,
        repoUrl: body.repoUrl,
        commitSha: body.commitSha,
        baseCommitSha: body.baseCommitSha,
        language: body.language,
        timeoutSeconds: Math.max(60, Math.min(body.timeoutSeconds ?? 300, 3600)),
        convexUrl: process.env.CONVEX_URL,
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

  return router;
}
