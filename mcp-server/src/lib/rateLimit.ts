import { createClient, type RedisClientType } from "redis";
import type { RateLimitStore } from "../config";

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export interface RateLimiter {
  check(
    key: string,
    maxTokens?: number,
    refillIntervalMs?: number,
  ): Promise<boolean>;
  close(): Promise<void>;
  mode(): RateLimitStore;
}

const DEFAULT_MAX_TOKENS = 60;
const DEFAULT_REFILL_INTERVAL_MS = 60_000;

class MemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private cleanupTimer: NodeJS.Timeout | undefined;

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanup(), 5 * 60 * 1000);
    this.cleanupTimer.unref();
  }

  async check(
    key: string,
    maxTokens = DEFAULT_MAX_TOKENS,
    refillIntervalMs = DEFAULT_REFILL_INTERVAL_MS,
  ): Promise<boolean> {
    return checkRateLimitInternal(this.buckets, key, maxTokens, refillIntervalMs);
  }

  async close(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  mode(): RateLimitStore {
    return "memory";
  }

  private cleanup(): void {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [key, bucket] of this.buckets) {
      if (bucket.lastRefill < cutoff) {
        this.buckets.delete(key);
      }
    }
  }
}

class RedisRateLimiter implements RateLimiter {
  private readonly client: RedisClientType;
  private connectPromise: Promise<void> | null = null;

  constructor(redisUrl: string) {
    this.client = createClient({ url: redisUrl });
  }

  async check(
    key: string,
    maxTokens = DEFAULT_MAX_TOKENS,
    refillIntervalMs = DEFAULT_REFILL_INTERVAL_MS,
  ): Promise<boolean> {
    await this.ensureConnected();
    const windowMs = Math.max(refillIntervalMs, 1000);
    const redisKey = `mcp:ratelimit:${key}`;
    const count = await this.client.incr(redisKey);
    if (count === 1) {
      await this.client.pExpire(redisKey, windowMs);
    }
    return count <= maxTokens;
  }

  async close(): Promise<void> {
    if (this.client.isOpen) {
      await this.client.quit();
    }
    this.connectPromise = null;
  }

  mode(): RateLimitStore {
    return "redis";
  }

  private ensureConnected(): Promise<void> {
    if (this.client.isOpen) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.client.connect()
      .then(() => undefined)
      .catch((err) => {
        this.connectPromise = null;
        throw err;
      });
    return this.connectPromise;
  }
}

export interface CreateRateLimiterOptions {
  store: RateLimitStore;
  redisUrl?: string;
}

export function createRateLimiter(options: CreateRateLimiterOptions): RateLimiter {
  if (options.store === "redis") {
    if (!options.redisUrl) {
      console.warn("[rate-limit] RATE_LIMIT_STORE=redis set but no redis URL was provided; falling back to memory");
      return new MemoryRateLimiter();
    }
    return new RedisRateLimiter(options.redisUrl);
  }
  return new MemoryRateLimiter();
}

function checkRateLimitInternal(
  buckets: Map<string, Bucket>,
  key: string,
  maxTokens: number,
  refillIntervalMs: number,
): boolean {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { tokens: maxTokens - 1, lastRefill: now };
    buckets.set(key, bucket);
    return true;
  }

  const elapsed = now - bucket.lastRefill;
  const tokensToAdd = Math.floor((elapsed / refillIntervalMs) * maxTokens);
  if (tokensToAdd > 0) {
    bucket.tokens = Math.min(maxTokens, bucket.tokens + tokensToAdd);
    bucket.lastRefill = now;
  }

  if (bucket.tokens > 0) {
    bucket.tokens -= 1;
    return true;
  }
  return false;
}

// Backward-compatible exports for existing tests/usages.
const legacyBuckets = new Map<string, Bucket>();
export function checkRateLimit(
  key: string,
  maxTokens = DEFAULT_MAX_TOKENS,
  refillIntervalMs = DEFAULT_REFILL_INTERVAL_MS,
): boolean {
  return checkRateLimitInternal(legacyBuckets, key, maxTokens, refillIntervalMs);
}

export function startCleanupInterval(): NodeJS.Timeout {
  return setInterval(() => {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [key, bucket] of legacyBuckets) {
      if (bucket.lastRefill < cutoff) {
        legacyBuckets.delete(key);
      }
    }
  }, 5 * 60 * 1000);
}
