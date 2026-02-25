import { constantTimeEqual } from "./constantTimeEqual";

function getWorkerHmacSecret(): string {
  const secret = process.env.WORKER_SHARED_SECRET ?? "";
  if (!secret) {
    throw new Error("WORKER_SHARED_SECRET must be configured");
  }
  return secret;
}

/**
 * SECURITY (H6): Generate a per-job HMAC token that must be presented
 * when posting verification results. This prevents a compromised worker
 * secret from being used to forge results for arbitrary submissions.
 */
export async function generateJobHmac(
  verificationId: string,
  submissionId: string,
  bountyId: string,
): Promise<string> {
  const secret = getWorkerHmacSecret();
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const data = `${verificationId}:${submissionId}:${bountyId}`;
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * SECURITY (H6): Verify per-job HMAC token to prevent forged verification results.
 * Uses constant-time comparison to prevent timing attacks.
 */
export async function verifyJobHmac(
  hmac: string,
  verificationId: string,
  submissionId: string,
  bountyId: string,
): Promise<boolean> {
  let secret: string;
  try {
    secret = getWorkerHmacSecret();
  } catch {
    return false;
  }
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const data = `${verificationId}:${submissionId}:${bountyId}`;
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  const expected = Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return constantTimeEqual(hmac, expected);
}

/**
 * SECURITY (H7): Sign worker callback envelopes with timestamp + nonce metadata.
 * This enables short-lived replay protection beyond static bearer auth.
 */
export async function generateWorkerCallbackSignature(params: {
  submissionId: string;
  bountyId: string;
  jobId: string;
  overallStatus: string;
  jobHmac: string;
  callbackTimestampMs: number;
  callbackNonce: string;
}): Promise<string> {
  const secret = getWorkerHmacSecret();
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const data = [
    params.submissionId,
    params.bountyId,
    params.jobId,
    params.overallStatus,
    params.jobHmac,
    String(params.callbackTimestampMs),
    params.callbackNonce,
  ].join(":");
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function verifyWorkerCallbackSignature(
  signature: string,
  params: {
    submissionId: string;
    bountyId: string;
    jobId: string;
    overallStatus: string;
    jobHmac: string;
    callbackTimestampMs: number;
    callbackNonce: string;
  },
): Promise<boolean> {
  const expected = await generateWorkerCallbackSignature(params);
  return constantTimeEqual(signature, expected);
}

/**
 * SECURITY (H7): Reject stale/future callback timestamps.
 */
export function isFreshWorkerCallbackTimestamp(
  callbackTimestampMs: number,
  nowMs = Date.now(),
  maxAgeMs = 5 * 60 * 1000,
  maxFutureSkewMs = 30 * 1000,
): boolean {
  if (!Number.isFinite(callbackTimestampMs)) return false;
  if (callbackTimestampMs > nowMs + maxFutureSkewMs) return false;
  if (callbackTimestampMs < nowMs - maxAgeMs) return false;
  return true;
}
