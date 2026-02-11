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
  /** Primary language hint (e.g. "typescript", "python") */
  language?: string;
  /** Optional per-job timeout override in seconds */
  timeoutSeconds?: number;
  /** Convex deployment URL to post results back to */
  convexUrl?: string;
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

      const jobData: VerificationJobData = {
        jobId,
        submissionId: body.submissionId,
        bountyId: body.bountyId,
        repoUrl: body.repoUrl,
        commitSha: body.commitSha,
        language: body.language,
        timeoutSeconds: body.timeoutSeconds ?? 300,
        convexUrl: body.convexUrl ?? process.env.CONVEX_URL,
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
      const job = await queue.getJob(req.params.id);

      if (!job) {
        res.status(404).json({ error: "Job not found" });
        return;
      }

      const state = await job.getState();

      res.json({
        jobId: job.id,
        status: state,
        data: job.data,
        progress: job.progress,
        result: job.returnvalue ?? null,
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
