import { Queue, Worker, QueueEvents } from "bullmq";
import IORedis from "ioredis";
import { logger } from "../index";
import { processVerificationJob, processVerificationFromDiff } from "./jobProcessor";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Test suite input from Convex with visibility metadata. */
export interface TestSuiteInput {
  id: string;
  title: string;
  gherkinContent: string;
  visibility: "public" | "hidden";
}

/** Shape of the data stored in each BullMQ job. */
export interface VerificationJobData {
  jobId: string;
  submissionId: string;
  bountyId: string;
  repoUrl: string;
  commitSha: string;
  /** Base commit SHA from the bounty's repoConnection for diff-scoped analysis. */
  baseCommitSha?: string;
  language?: string;
  timeoutSeconds: number;
  convexUrl?: string;
  /** Test suites with visibility, sent from Convex dispatchVerification. */
  testSuites?: TestSuiteInput[];
  /** Creator's gate settings — gates can be individually disabled. */
  gateSettings?: {
    snykEnabled?: boolean;
    sonarqubeEnabled?: boolean;
  };
  /** Step definitions for public scenarios (injected into VM at test time). */
  stepDefinitionsPublic?: string;
  /** Step definitions for hidden scenarios (injected into VM at test time). */
  stepDefinitionsHidden?: string;
  /** ZTACO mode: all gates block (no fail-fast). */
  ztacoMode?: boolean;
  /** Attempt number for this submission (1-indexed). */
  attemptNumber?: number;
  /** Diff patch to apply instead of checking out a specific commit. */
  diffPatch?: string;
  /** Source workspace ID (for tracking). */
  sourceWorkspaceId?: string;
}

/** Possible outcome of a single gate. */
export type GateStatus = "pass" | "fail" | "error" | "skipped";

/** An individual BDD scenario result with visibility tagging. */
export interface StepResult {
  scenarioName: string;
  featureName: string;
  status: "pass" | "fail" | "skip" | "error";
  executionTimeMs: number;
  output?: string;
  stepNumber: number;
  visibility: "public" | "hidden";
}

/** Result reported by an individual gate. */
export interface GateResult {
  gate: string;
  status: GateStatus;
  durationMs: number;
  summary: string;
  details?: Record<string, unknown>;
  /** Individual BDD scenario results with visibility tagging (test gate only). */
  steps?: StepResult[];
}

/** Top-level verification result returned as the job's return value. */
export interface VerificationResult {
  jobId: string;
  submissionId: string;
  bountyId: string;
  overallStatus: "pass" | "fail" | "error";
  gates: GateResult[];
  totalDurationMs: number;
  /** Aggregated BDD scenario steps with visibility tagging. */
  steps?: StepResult[];
  /** Structured feedback JSON for iterative improvement. */
  feedbackJson?: string;
}

// ---------------------------------------------------------------------------
// Queue name
// ---------------------------------------------------------------------------
const QUEUE_NAME = "verification";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Initialise the BullMQ queue and the worker that processes verification jobs.
 */
export async function createVerificationQueue(redisUrl: string): Promise<{
  queue: Queue<VerificationJobData>;
  worker: Worker<VerificationJobData, VerificationResult>;
  queueEvents: QueueEvents;
}> {
  const connection = new IORedis(redisUrl, {
    maxRetriesPerRequest: null,  // required by BullMQ
    enableReadyCheck: false,
  });

  connection.on("error", (err) => {
    logger.error("Redis connection error", { error: err.message });
  });

  const queue = new Queue<VerificationJobData>(QUEUE_NAME, { connection });

  const worker = new Worker<VerificationJobData, VerificationResult>(
    QUEUE_NAME,
    async (job) => {
      logger.info("Processing verification job", {
        jobId: job.id,
        submissionId: job.data.submissionId,
        isDiffBased: !!job.data.diffPatch,
      });
      // Route to diff-based processor if a diffPatch is present
      if (job.data.diffPatch) {
        return processVerificationFromDiff(job);
      }
      return processVerificationJob(job);
    },
    {
      connection,
      concurrency: parseInt(process.env.WORKER_CONCURRENCY ?? "2", 10),
      limiter: {
        max: 10,
        duration: 60_000,  // max 10 jobs per minute
      },
    },
  );

  worker.on("completed", (job) => {
    logger.info("Verification job completed", {
      jobId: job.id,
      result: job.returnvalue?.overallStatus,
    });
  });

  worker.on("failed", (job, err) => {
    logger.error("Verification job failed", {
      jobId: job?.id,
      error: err.message,
    });
  });

  worker.on("error", (err) => {
    logger.error("Worker error", { error: err.message });
  });

  const queueEvents = new QueueEvents(QUEUE_NAME, { connection });

  return { queue, worker, queueEvents };
}

/**
 * Gracefully close the queue and its Redis connection.
 */
export async function closeQueue(
  queue: Queue<VerificationJobData>,
): Promise<void> {
  await queue.close();
  logger.info("BullMQ queue closed");
}
