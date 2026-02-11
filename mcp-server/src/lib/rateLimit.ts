/**
 * In-memory token bucket rate limiter.
 * Each key (API key hash) gets an independent bucket.
 */

interface Bucket {
  tokens: number;
  lastRefill: number;
}

const buckets = new Map<string, Bucket>();

const DEFAULT_MAX_TOKENS = 60; // 60 requests
const DEFAULT_REFILL_INTERVAL_MS = 60_000; // per minute

export function checkRateLimit(
  key: string,
  maxTokens = DEFAULT_MAX_TOKENS,
  refillIntervalMs = DEFAULT_REFILL_INTERVAL_MS,
): boolean {
  const now = Date.now();
  let bucket = buckets.get(key);

  if (!bucket) {
    bucket = { tokens: maxTokens - 1, lastRefill: now };
    buckets.set(key, bucket);
    return true;
  }

  // Refill tokens based on elapsed time
  const elapsed = now - bucket.lastRefill;
  const tokensToAdd = Math.floor(
    (elapsed / refillIntervalMs) * maxTokens
  );

  if (tokensToAdd > 0) {
    bucket.tokens = Math.min(maxTokens, bucket.tokens + tokensToAdd);
    bucket.lastRefill = now;
  }

  if (bucket.tokens > 0) {
    bucket.tokens--;
    return true;
  }

  return false;
}

/**
 * Periodically clean up stale buckets (keys not seen in 10 minutes).
 */
export function startCleanupInterval(): NodeJS.Timeout {
  return setInterval(
    () => {
      const cutoff = Date.now() - 10 * 60 * 1000;
      for (const [key, bucket] of buckets) {
        if (bucket.lastRefill < cutoff) {
          buckets.delete(key);
        }
      }
    },
    5 * 60 * 1000,
  );
}
