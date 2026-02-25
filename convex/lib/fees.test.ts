import { describe, it, expect } from "vitest";
import {
  calculatePlatformFee,
  PLATFORM_FEE_RATE,
  MIN_BOUNTY_REWARD,
  MIN_S_TIER_BOUNTY_REWARD,
} from "./fees";

describe("fees constants", () => {
  it("PLATFORM_FEE_RATE is 8%", () => {
    expect(PLATFORM_FEE_RATE).toBe(0.08);
  });

  it("MIN_BOUNTY_REWARD is $50", () => {
    expect(MIN_BOUNTY_REWARD).toBe(50);
  });

  it("MIN_S_TIER_BOUNTY_REWARD is $150", () => {
    expect(MIN_S_TIER_BOUNTY_REWARD).toBe(150);
  });
});

describe("calculatePlatformFee", () => {
  it("returns correct fee/solver split for $100 (10000 cents)", () => {
    const result = calculatePlatformFee(10000);
    expect(result.feeCents).toBe(800);
    expect(result.solverCents).toBe(9200);
  });

  it("returns correct fee/solver split for $50 (5000 cents)", () => {
    const result = calculatePlatformFee(5000);
    expect(result.feeCents).toBe(400);
    expect(result.solverCents).toBe(4600);
  });

  it("returns correct fee/solver split for $1000 (100000 cents)", () => {
    const result = calculatePlatformFee(100000);
    expect(result.feeCents).toBe(8000);
    expect(result.solverCents).toBe(92000);
  });

  it("handles 0 input", () => {
    const result = calculatePlatformFee(0);
    expect(result.feeCents).toBe(0);
    expect(result.solverCents).toBe(0);
  });

  describe("rounding edge cases", () => {
    it("rounds correctly for 1 cent", () => {
      // 1 * 0.08 = 0.08 -> rounds to 0
      const result = calculatePlatformFee(1);
      expect(result.feeCents).toBe(0);
      expect(result.solverCents).toBe(1);
    });

    it("rounds correctly for 333 cents", () => {
      // 333 * 0.08 = 26.64 -> Math.round = 27
      const result = calculatePlatformFee(333);
      expect(result.feeCents).toBe(27);
      expect(result.solverCents).toBe(306);
    });

    it("rounds correctly for 33 cents", () => {
      // 33 * 0.08 = 2.64 -> rounds to 3
      const result = calculatePlatformFee(33);
      expect(result.feeCents).toBe(3);
      expect(result.solverCents).toBe(30);
    });

    it("rounds correctly for 17 cents (half-cent boundary)", () => {
      // 17 * 0.08 = 1.36 -> rounds to 1
      const result = calculatePlatformFee(17);
      expect(result.feeCents).toBe(1);
      expect(result.solverCents).toBe(16);
    });

    it("rounds correctly for 50 cents", () => {
      // 50 * 0.08 = 4 -> Math.round rounds to 4
      const result = calculatePlatformFee(50);
      expect(result.feeCents).toBe(4);
      expect(result.solverCents).toBe(46);
    });
  });

  describe("fee + solver = reward invariant", () => {
    const testValues = [
      0, 1, 2, 3, 10, 33, 50, 99, 100, 150, 333, 500, 999, 1000, 5000,
      10000, 25000, 50000, 100000, 999999,
    ];

    it.each(testValues)(
      "feeCents + solverCents = rewardCents for %d cents",
      (rewardCents) => {
        const { feeCents, solverCents } = calculatePlatformFee(rewardCents);
        expect(feeCents + solverCents).toBe(rewardCents);
      }
    );
  });

  it("fee is always non-negative", () => {
    for (const cents of [0, 1, 5, 10, 100, 10000]) {
      const { feeCents } = calculatePlatformFee(cents);
      expect(feeCents).toBeGreaterThanOrEqual(0);
    }
  });

  it("solver payout is always non-negative", () => {
    for (const cents of [0, 1, 5, 10, 100, 10000]) {
      const { solverCents } = calculatePlatformFee(cents);
      expect(solverCents).toBeGreaterThanOrEqual(0);
    }
  });
});
