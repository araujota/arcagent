import { logger } from "../index";
import { VerificationResult } from "../queue/jobQueue";

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
  const configuredUrl = process.env.CONVEX_URL;
  if (configuredUrl && url === configuredUrl) return;

  try {
    const parsed = new URL(url);
    if (parsed.hostname.endsWith(".convex.cloud") || parsed.hostname === "localhost") {
      return;
    }
  } catch {
    throw new Error(`Invalid Convex URL: ${url}`);
  }
  throw new Error(
    `Untrusted Convex URL: ${url}. Must match CONVEX_URL env var or end with .convex.cloud`
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
    steps: result.steps,
    jobHmac: result.jobHmac,
  };

  const secret = process.env.WORKER_SHARED_SECRET;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        REQUEST_TIMEOUT_MS,
      );

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalise the Convex URL and append the result endpoint path.
 */
function buildResultUrl(convexUrl: string): string {
  // Strip trailing slash
  const base = convexUrl.replace(/\/+$/, "");

  // If the URL is a Convex deployment URL (e.g. https://foo-bar-123.convex.cloud)
  // the HTTP action endpoint is under the same origin.
  return `${base}/api/verification/result`;
}
