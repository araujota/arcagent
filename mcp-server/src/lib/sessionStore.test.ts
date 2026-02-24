import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { SessionStore } from "./sessionStore";

describe("SessionStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stores ownership and refreshes TTL on access", () => {
    const store = new SessionStore(1000, 10);
    store.setOwned("s1", "u1");

    vi.advanceTimersByTime(800);
    expect(store.get("s1")?.userId).toBe("u1");

    vi.advanceTimersByTime(800);
    expect(store.get("s1")).toBeTruthy();
  });

  it("expires sessions", () => {
    const store = new SessionStore(500, 10);
    store.setOwned("s1", "u1");
    vi.advanceTimersByTime(600);
    expect(store.get("s1")).toBeUndefined();
  });

  it("evicts oldest session when max exceeded", () => {
    const store = new SessionStore(10_000, 2);
    store.setOwned("s1", "u1");
    vi.advanceTimersByTime(1);
    store.setOwned("s2", "u1");
    vi.advanceTimersByTime(1);
    store.setOwned("s3", "u1");

    expect(store.get("s1")).toBeUndefined();
    expect(store.get("s2")).toBeTruthy();
    expect(store.get("s3")).toBeTruthy();
  });
});
