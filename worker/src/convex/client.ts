import { logger } from "../index";
import { ValidationReceipt, VerificationResult } from "../queue/jobQueue";
import { buildWorkerCallbackEnvelope } from "../lib/callbackAuth";
import {
  resolveConfiguredConvexHttpActionsUrl,
  toConvexHttpActionsBaseUrl,
} from "./url";

/**
 * HTTP client for posting verification results back to the Convex deployment.
 *
 * Uses Convex HTTP actions to push gate results and overall status.  The
 * endpoint is expected to be an HTTP action at:
 *   POST {convexUrl}/api/verification/result
 *
 * Authentication uses the shared worker secret.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ConvexResultPayload {
  submissionId: string;
  bountyId: string;
  jobId: string;
  overallStatus: "pass" | "fail" | "error";
  gates: Array<{
    gate: string;
    status: string;
    durationMs: number;
    summary: string;
    details?: Record<string, unknown>;
  }>;
  totalDurationMs: number;
  feedbackJson?: string;
  validationReceipts?: Array<{
    verificationId?: string;
    attemptNumber: number;
    legKey: string;
    orderIndex: number;
    status: string;
    blocking: boolean;
    unreachedByLegKey?: string;
    startedAt: number;
    completedAt: number;
    durationMs: number;
    summaryLine: string;
    rawBody?: string;
    sarifJson?: string;
    policyJson?: string;
    metadataJson?: string;
  }>;
  steps?: Array<{
    scenarioName: string;
    featureName: string;
    status: "pass" | "fail" | "skip" | "error";
    executionTimeMs: number;
    output?: string;
    stepNumber: number;
    visibility: "public" | "hidden";
  }>;
  /** SECURITY (H6): Per-job HMAC token for result verification. */
  jobHmac?: string;
  /** SECURITY (H7): Signed callback envelope metadata. */
  callbackTimestampMs?: number;
  callbackNonce?: string;
  callbackSignature?: string;
}

interface ConvexReceiptPayload {
  verificationId?: string;
  submissionId: string;
  bountyId: string;
  jobId: string;
  attemptNumber: number;
  legKey: string;
  orderIndex: number;
  status: string;
  blocking: boolean;
  unreachedByLegKey?: string;
  startedAt: number;
  completedAt: number;
  durationMs: number;
  summaryLine: string;
  rawBody?: string;
  sarifJson?: string;
  policyJson?: string;
  metadataJson?: string;
  jobHmac?: string;
  callbackTimestampMs?: number;
  callbackNonce?: string;
  callbackSignature?: string;
}

interface ConvexArtifactPayload {
  verificationId?: string;
  submissionId: string;
  bountyId: string;
  jobId: string;
  attemptNumber: number;
  filename: string;
  contentType: string;
  sha256: string;
  bytes: number;
  manifestJson: string;
  bundleBase64: string;
  jobHmac?: string;
  callbackTimestampMs?: number;
  callbackNonce?: string;
  callbackSignature?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1_000;
const REQUEST_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * SECURITY (C4): Validate that the Convex URL is a trusted destination.
 * Rejects attacker-controlled URLs that could exfiltrate verification results.
 */
function validateConvexUrl(url: string): void {
  const configuredUrl = resolveConfiguredConvexHttpActionsUrl();
  if (configuredUrl && url === configuredUrl) return;

  try {
    const parsed = new URL(url);
    if (
      parsed.hostname.endsWith(".convex.cloud") ||
      parsed.hostname.endsWith(".convex.site") ||
      parsed.hostname === "localhost"
    ) {
      return;
    }
  } catch {
    throw new Error(`Invalid Convex URL: ${url}`);
  }
  throw new Error(
    `Untrusted Convex URL: ${url}. Must match CONVEX_HTTP_ACTIONS_URL/CONVEX_URL env var or use .convex.site/.convex.cloud`
  );
}

/**
 * Post the final verification result to the Convex HTTP action endpoint.
 *
 * Retries up to {@link MAX_RETRIES} times with exponential back-off on
 * transient failures (5xx, network errors).
 */
export async function postVerificationResult(
  convexUrl: string,
  result: VerificationResult,
): Promise<void> {
  validateConvexUrl(convexUrl);
  const url = buildResultUrl(convexUrl);
  const payload: ConvexResultPayload = {
    submissionId: result.submissionId,
    bountyId: result.bountyId,
    jobId: result.jobId,
    overallStatus: result.overallStatus,
    gates: result.gates.map((g) => ({
      gate: g.gate,
      status: g.status,
      durationMs: g.durationMs,
      summary: g.summary,
      details: g.details,
    })),
    totalDurationMs: result.totalDurationMs,
    feedbackJson: result.feedbackJson,
    validationReceipts: result.validationReceipts,
    steps: result.steps,
    jobHmac: result.jobHmac,
  };

  const secret = process.env.WORKER_SHARED_SECRET;

  if (!payload.jobHmac) {
    throw new Error("Missing jobHmac in verification result payload");
  }
  if (!secret) {
    throw new Error("WORKER_SHARED_SECRET must be configured");
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const callbackEnvelope = buildWorkerCallbackEnvelope({
        secret,
        submissionId: payload.submissionId,
        bountyId: payload.bountyId,
        jobId: payload.jobId,
        overallStatus: payload.overallStatus,
        jobHmac: payload.jobHmac,
      });
      payload.callbackTimestampMs = callbackEnvelope.callbackTimestampMs;
      payload.callbackNonce = callbackEnvelope.callbackNonce;
      payload.callbackSignature = callbackEnvelope.callbackSignature;

      const response = await postJson(url, payload, secret);

      if (response.ok) {
        logger.info("Successfully posted result to Convex", {
          jobId: result.jobId,
          status: response.status,
        });
        return;
      }

      // Non-retryable client errors
      if (response.status >= 400 && response.status < 500) {
        const body = await response.text().catch(() => "");
        logger.error("Convex returned client error (not retrying)", {
          jobId: result.jobId,
          status: response.status,
          body: body.slice(0, 500),
        });
        throw new Error(
          `Convex HTTP ${response.status}: ${body.slice(0, 200)}`,
        );
      }

      // Server errors are retryable
      logger.warn("Convex returned server error", {
        jobId: result.jobId,
        status: response.status,
        attempt,
      });
    } catch (err) {
      if (
        err instanceof Error &&
        err.message.startsWith("Convex HTTP 4")
      ) {
        throw err; // Don't retry client errors
      }

      logger.warn("Failed to post result to Convex", {
        jobId: result.jobId,
        attempt,
        error: err instanceof Error ? err.message : String(err),
      });

      if (attempt === MAX_RETRIES) {
        throw new Error(
          `Failed to post result to Convex after ${MAX_RETRIES} attempts`,
        );
      }
    }

    // Exponential back-off
    const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
    await new Promise((r) => setTimeout(r, delay));
  }
}

export async function postVerificationReceipt(
  convexUrl: string,
  receipt: ValidationReceipt,
  jobHmac: string,
): Promise<void> {
  validateConvexUrl(convexUrl);
  const secret = process.env.WORKER_SHARED_SECRET;
  if (!secret) throw new Error("WORKER_SHARED_SECRET must be configured");
  if (!jobHmac) throw new Error("Missing jobHmac in verification receipt payload");

  const url = buildReceiptUrl(convexUrl);
  const payload: ConvexReceiptPayload = {
    verificationId: receipt.verificationId,
    submissionId: receipt.submissionId,
    bountyId: receipt.bountyId,
    jobId: receipt.jobId,
    attemptNumber: receipt.attemptNumber,
    legKey: receipt.legKey,
    orderIndex: receipt.orderIndex,
    status: receipt.status,
    blocking: receipt.blocking,
    unreachedByLegKey: receipt.unreachedByLegKey,
    startedAt: receipt.startedAt,
    completedAt: receipt.completedAt,
    durationMs: receipt.durationMs,
    summaryLine: receipt.summaryLine,
    rawBody: receipt.rawBody,
    sarifJson: receipt.sarifJson,
    policyJson: receipt.policyJson,
    metadataJson: receipt.metadataJson,
    jobHmac,
  };

  const callbackEnvelope = buildWorkerCallbackEnvelope({
    secret,
    submissionId: payload.submissionId,
    bountyId: payload.bountyId,
    jobId: payload.jobId,
    overallStatus: payload.status,
    jobHmac,
  });
  payload.callbackTimestampMs = callbackEnvelope.callbackTimestampMs;
  payload.callbackNonce = callbackEnvelope.callbackNonce;
  payload.callbackSignature = callbackEnvelope.callbackSignature;

  const response = await postJson(url, payload, secret);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Convex receipt HTTP ${response.status}: ${body.slice(0, 200)}`);
  }
}

export async function postVerificationArtifact(
  convexUrl: string,
  artifact: Omit<ConvexArtifactPayload, "callbackTimestampMs" | "callbackNonce" | "callbackSignature">,
): Promise<void> {
  validateConvexUrl(convexUrl);
  const secret = process.env.WORKER_SHARED_SECRET;
  if (!secret) throw new Error("WORKER_SHARED_SECRET must be configured");
  if (!artifact.jobHmac) throw new Error("Missing jobHmac in verification artifact payload");
  const jobHmac = artifact.jobHmac;

  const payload: ConvexArtifactPayload = { ...artifact };
  const callbackEnvelope = buildWorkerCallbackEnvelope({
    secret,
    submissionId: payload.submissionId,
    bountyId: payload.bountyId,
    jobId: payload.jobId,
    overallStatus: "artifact",
    jobHmac,
  });
  payload.callbackTimestampMs = callbackEnvelope.callbackTimestampMs;
  payload.callbackNonce = callbackEnvelope.callbackNonce;
  payload.callbackSignature = callbackEnvelope.callbackSignature;

  const url = buildArtifactUrl(convexUrl);
  const response = await postJson(url, payload, secret);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Convex artifact HTTP ${response.status}: ${body.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalise the Convex URL and append the result endpoint path.
 */
function buildResultUrl(convexUrl: string): string {
  const base = toConvexHttpActionsBaseUrl(convexUrl);
  return `${base}/api/verification/result`;
}

function buildReceiptUrl(convexUrl: string): string {
  const base = toConvexHttpActionsBaseUrl(convexUrl);
  return `${base}/api/verification/receipt`;
}

function buildArtifactUrl(convexUrl: string): string {
  const base = toConvexHttpActionsBaseUrl(convexUrl);
  return `${base}/api/verification/artifact`;
}

async function postJson(url: string, payload: unknown, secret: string): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS,
  );
  try {
    return await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}
