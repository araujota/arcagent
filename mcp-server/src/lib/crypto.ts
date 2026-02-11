import { createHash, randomBytes } from "crypto";

const KEY_PREFIX = "arc_";
const KEY_BYTES = 16; // 128 bits of entropy → 32 hex chars

/**
 * Generate a new API key with the format: arc_{32 hex chars}
 * Returns both the plaintext key and its SHA-256 hash.
 */
export function generateApiKey(): { plaintext: string; hash: string; prefix: string } {
  const randomPart = randomBytes(KEY_BYTES).toString("hex");
  const plaintext = `${KEY_PREFIX}${randomPart}`;
  const hash = hashApiKey(plaintext);
  const prefix = plaintext.slice(0, 8);

  return { plaintext, hash, prefix };
}

/**
 * SHA-256 hash of an API key (for storage and lookup).
 */
export function hashApiKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}
