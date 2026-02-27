import { constantTimeEqual } from "./constantTimeEqual";

const TOKEN_SECRET_ENV = "ATTEMPT_WORKER_SERVICE_TOKEN_SECRET";
const SIGNING_SECRET_ENV = "ATTEMPT_WORKER_TOKEN_SIGNING_SECRET";

function getSecret(envName: string): string {
  const secret = process.env[envName] ?? "";
  if (!secret) {
    throw new Error(`${envName} must be configured for dedicated attempt workers`);
  }
  return secret;
}

async function hmacHex(secret: string, payload: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function deriveAttemptServiceToken(attemptWorkerId: string): Promise<string> {
  return await hmacHex(getSecret(TOKEN_SECRET_ENV), `svc:${attemptWorkerId}`);
}

export async function deriveAttemptServiceTokenHash(attemptWorkerId: string): Promise<string> {
  const token = await deriveAttemptServiceToken(attemptWorkerId);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function deriveAttemptTokenSigningSecret(attemptWorkerId: string): Promise<string> {
  return await hmacHex(getSecret(SIGNING_SECRET_ENV), `jwt:${attemptWorkerId}`);
}

export async function verifyAttemptServiceTokenHash(
  attemptWorkerId: string,
  storedHash: string,
): Promise<boolean> {
  const actual = await deriveAttemptServiceTokenHash(attemptWorkerId);
  return constantTimeEqual(actual, storedHash);
}
