import { constantTimeEqual } from "./constantTimeEqual";

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
  const secret = process.env.WORKER_SHARED_SECRET || process.env.WORKER_API_SECRET || "";
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
  const secret = process.env.WORKER_SHARED_SECRET || "";
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
