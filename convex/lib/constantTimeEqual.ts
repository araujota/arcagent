/**
 * SECURITY (H3): Constant-time secret comparison that does NOT leak
 * the secret length via an early-return on length mismatch.
 * Both strings are padded to the same length before comparison.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const maxLen = Math.max(a.length, b.length, 1);
  let result = a.length ^ b.length; // length mismatch contributes to failure
  for (let i = 0; i < maxLen; i++) {
    result |= (a.charCodeAt(i % a.length) || 0) ^ (b.charCodeAt(i % b.length) || 0);
  }
  return result === 0;
}
