import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { checkRateLimit } from "./rateLimit";

describe("checkRateLimit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("first call returns true (creates bucket)", () => {
    // Use unique keys per test to avoid cross-contamination
    expect(checkRateLimit("test-key-first", 5, 60_000)).toBe(true);
  });

  it("exhausting all tokens -> next call returns false", () => {
    const key = "test-key-exhaust";
    // maxTokens = 3; first call creates bucket with 2 remaining
    expect(checkRateLimit(key, 3, 60_000)).toBe(true); // tokens: 2
    expect(checkRateLimit(key, 3, 60_000)).toBe(true); // tokens: 1
    expect(checkRateLimit(key, 3, 60_000)).toBe(true); // tokens: 0
    expect(checkRateLimit(key, 3, 60_000)).toBe(false); // exhausted
  });

  it("after time advance -> tokens refilled", () => {
    const key = "test-key-refill";
    // Exhaust all tokens (maxTokens = 2)
    expect(checkRateLimit(key, 2, 60_000)).toBe(true); // tokens: 1
    expect(checkRateLimit(key, 2, 60_000)).toBe(true); // tokens: 0
    expect(checkRateLimit(key, 2, 60_000)).toBe(false); // exhausted

    // Advance time by the full interval to refill
    vi.advanceTimersByTime(60_000);

    // Should have tokens now
    expect(checkRateLimit(key, 2, 60_000)).toBe(true);
  });

  it("different keys have independent buckets", () => {
    const key1 = "test-key-independent-1";
    const key2 = "test-key-independent-2";

    // Exhaust key1 (maxTokens = 1)
    expect(checkRateLimit(key1, 1, 60_000)).toBe(true); // tokens: 0
    expect(checkRateLimit(key1, 1, 60_000)).toBe(false); // exhausted

    // key2 should still work
    expect(checkRateLimit(key2, 1, 60_000)).toBe(true);
  });

  it("partial time advance refills proportionally", () => {
    const key = "test-key-partial";
    // maxTokens = 10, refill every 60s
    // Exhaust all tokens
    for (let i = 0; i < 10; i++) {
      checkRateLimit(key, 10, 60_000);
    }
    expect(checkRateLimit(key, 10, 60_000)).toBe(false);

    // Advance 30 seconds (half interval) -> should add 5 tokens
    vi.advanceTimersByTime(30_000);
    expect(checkRateLimit(key, 10, 60_000)).toBe(true);
  });
});
