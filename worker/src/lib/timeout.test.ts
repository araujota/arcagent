import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withTimeout, TimeBudget, TimeoutError } from "./timeout";

// ---------------------------------------------------------------------------
// withTimeout
// ---------------------------------------------------------------------------

describe("withTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves when fn completes before timeout", async () => {
    const fn = () => Promise.resolve("done");
    const result = await withTimeout(fn, 5000);
    expect(result).toBe("done");
  });

  it("rejects with TimeoutError when fn exceeds timeout", async () => {
    const fn = () => new Promise<string>((resolve) => setTimeout(() => resolve("late"), 10_000));

    const promise = withTimeout(fn, 1000);
    vi.advanceTimersByTime(1001);

    await expect(promise).rejects.toThrow(TimeoutError);
    await expect(promise).rejects.toThrow("timed out after 1000ms");
  });

  it("uses custom error message when provided", async () => {
    const fn = () => new Promise<string>(() => {}); // never resolves

    const promise = withTimeout(fn, 100, "Build step timed out");
    vi.advanceTimersByTime(101);

    await expect(promise).rejects.toThrow("Build step timed out");
  });

  it("propagates fn rejection (not timeout)", async () => {
    const fn = () => Promise.reject(new Error("fn failed"));
    await expect(withTimeout(fn, 5000)).rejects.toThrow("fn failed");
  });

  it("executes fn immediately when timeoutMs <= 0", async () => {
    const fn = () => Promise.resolve("immediate");
    const result = await withTimeout(fn, 0);
    expect(result).toBe("immediate");
  });
});

// ---------------------------------------------------------------------------
// TimeBudget
// ---------------------------------------------------------------------------

describe("TimeBudget", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("remaining() returns totalMs - elapsed", () => {
    const budget = new TimeBudget(5000);
    vi.advanceTimersByTime(2000);
    expect(budget.remaining()).toBe(3000);
  });

  it("remaining() returns 0 when fully consumed", () => {
    const budget = new TimeBudget(1000);
    vi.advanceTimersByTime(2000);
    expect(budget.remaining()).toBe(0);
  });

  it("isExpired() returns false before totalMs", () => {
    const budget = new TimeBudget(5000);
    vi.advanceTimersByTime(1000);
    expect(budget.isExpired()).toBe(false);
  });

  it("isExpired() returns true after totalMs", () => {
    const budget = new TimeBudget(1000);
    vi.advanceTimersByTime(1001);
    expect(budget.isExpired()).toBe(true);
  });

  it("assertNotExpired() throws TimeoutError when expired", () => {
    const budget = new TimeBudget(1000);
    vi.advanceTimersByTime(1001);
    expect(() => budget.assertNotExpired()).toThrow(TimeoutError);
  });

  it("assertNotExpired() does not throw when not expired", () => {
    const budget = new TimeBudget(5000);
    expect(() => budget.assertNotExpired()).not.toThrow();
  });

  it("assertNotExpired() uses custom context in error message", () => {
    const budget = new TimeBudget(100);
    vi.advanceTimersByTime(200);
    expect(() => budget.assertNotExpired("Gate timed out")).toThrow("Gate timed out");
  });
});
