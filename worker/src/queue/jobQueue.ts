import { Queue, Worker, QueueEvents } from "bullmq";
import IORedis from "ioredis";
import { logger } from "../index";
import { processVerificationJob } from "./jobProcessor";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shape of the data stored in each BullMQ job. */
export interface VerificationJobData {
  jobId: string;
  submissionId: string;
  bountyId: string;
  repoUrl: string;
  commitSha: string;
  language?: string;
  timeoutSeconds: number;
  convexUrl?: string;
}

/** Possible outcome of a single gate. */
export type GateStatus = "pass" | "fail" | "error" | "skipped";

/** Result reported by an individual gate. */
export interface GateResult {
  gate: string;
  status: GateStatus;
  durationMs: number;
  summary: string;
  details?: Record<string, unknown>;
}

/** Top-level verification result returned as the job's return value. */
export interface VerificationResult {
  jobId: string;
  submissionId: string;
  bountyId: string;
  overallStatus: "pass" | "fail" | "error";
  gates: GateResult[];
  totalDurationMs: number;
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
      });
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
