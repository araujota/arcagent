import { describe, it, expect } from "vitest";
import {
  SCORE_WEIGHTS,
  TIER_RANK,
  TIER_THRESHOLDS,
  MIN_COMPLETED_BOUNTIES,
  MIN_UNIQUE_RATERS,
  MIN_TIER_ELIGIBLE_REWARD,
  SAME_CREATOR_30D_LIMIT,
  CONCENTRATION_CAP_THRESHOLD,
  timeDecayWeight,
  rewardWeight,
  assignTierByPercentile,
} from "./tierCalculation";

describe("constants", () => {
  it("SCORE_WEIGHTS sum to 1.0", () => {
    const sum = Object.values(SCORE_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 10);
  });

  it("SCORE_WEIGHTS has the expected keys and values", () => {
    expect(SCORE_WEIGHTS).toEqual({
      creatorRating: 0.32,
      timeToResolution: 0.16,
      firstAttemptPass: 0.16,
      gateQuality: 0.08,
      completionRate: 0.08,
      sonarRiskDiscipline: 0.10,
      snykMinorDiscipline: 0.06,
      advisoryReliability: 0.04,
    });
  });

  it("TIER_RANK maps tiers correctly", () => {
    expect(TIER_RANK).toEqual({
      S: 5,
      A: 4,
      B: 3,
      C: 2,
      D: 1,
      unranked: 0,
    });
  });

  it("TIER_RANK values are strictly ordered", () => {
    expect(TIER_RANK["S"]).toBeGreaterThan(TIER_RANK["A"]);
    expect(TIER_RANK["A"]).toBeGreaterThan(TIER_RANK["B"]);
    expect(TIER_RANK["B"]).toBeGreaterThan(TIER_RANK["C"]);
    expect(TIER_RANK["C"]).toBeGreaterThan(TIER_RANK["D"]);
    expect(TIER_RANK["D"]).toBeGreaterThan(TIER_RANK["unranked"]);
  });

  it("TIER_THRESHOLDS has correct percentile cutoffs", () => {
    expect(TIER_THRESHOLDS).toEqual({
      S: 0.10,
      A: 0.30,
      B: 0.60,
      C: 0.85,
    });
  });

  it("other constants have expected values", () => {
    expect(MIN_COMPLETED_BOUNTIES).toBe(5);
    expect(MIN_UNIQUE_RATERS).toBe(3);
    expect(MIN_TIER_ELIGIBLE_REWARD).toBe(25);
    expect(SAME_CREATOR_30D_LIMIT).toBe(3);
    expect(CONCENTRATION_CAP_THRESHOLD).toBe(0.6);
  });
});

describe("timeDecayWeight", () => {
  it("returns 1.0 for 0 age (no decay)", () => {
    expect(timeDecayWeight(0)).toBe(1.0);
  });

  it("returns approximately 0.5 at ~69.3 days (half-life)", () => {
    // half-life = ln(2) / 0.01 ~ 69.31 days
    const halfLifeDays = Math.LN2 / 0.01;
    const halfLifeMs = halfLifeDays * 24 * 60 * 60 * 1000;
    expect(timeDecayWeight(halfLifeMs)).toBeCloseTo(0.5, 5);
  });

  it("decays to near 0 for very large age", () => {
    const oneYearMs = 365 * 24 * 60 * 60 * 1000;
    const weight = timeDecayWeight(oneYearMs);
    expect(weight).toBeLessThan(0.03);
    expect(weight).toBeGreaterThan(0);
  });

  it("is monotonically decreasing", () => {
    const dayMs = 24 * 60 * 60 * 1000;
    let prevWeight = timeDecayWeight(0);
    for (let days = 1; days <= 365; days += 10) {
      const weight = timeDecayWeight(days * dayMs);
      expect(weight).toBeLessThan(prevWeight);
      prevWeight = weight;
    }
  });

  it("is always positive", () => {
    const dayMs = 24 * 60 * 60 * 1000;
    for (const days of [0, 1, 10, 100, 1000, 10000]) {
      expect(timeDecayWeight(days * dayMs)).toBeGreaterThan(0);
    }
  });

  it("returns correct value at 1 day", () => {
    const oneDayMs = 24 * 60 * 60 * 1000;
    expect(timeDecayWeight(oneDayMs)).toBeCloseTo(Math.exp(-0.01), 10);
  });
});

describe("rewardWeight", () => {
  it("returns exactly 1.0 for $25 bounty", () => {
    // log2(25/25 + 1) = log2(2) = 1.0
    expect(rewardWeight(25)).toBe(1.0);
  });

  it("returns 0 for $0 bounty", () => {
    // log2(0/25 + 1) = log2(1) = 0
    expect(rewardWeight(0)).toBe(0);
  });

  it("returns approximately 2.32 for $100 bounty", () => {
    // log2(100/25 + 1) = log2(5) ~ 2.322
    expect(rewardWeight(100)).toBeCloseTo(Math.log2(5), 5);
  });

  it("returns approximately 4.39 for $500 bounty", () => {
    // log2(500/25 + 1) = log2(21) ~ 4.392
    expect(rewardWeight(500)).toBeCloseTo(Math.log2(21), 5);
  });

  it("is monotonically increasing", () => {
    const rewards = [0, 10, 25, 50, 100, 200, 500, 1000, 5000];
    for (let i = 1; i < rewards.length; i++) {
      expect(rewardWeight(rewards[i])).toBeGreaterThan(
        rewardWeight(rewards[i - 1])
      );
    }
  });

  it("is always non-negative for non-negative rewards", () => {
    for (const reward of [0, 1, 10, 25, 100, 1000]) {
      expect(rewardWeight(reward)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("assignTierByPercentile", () => {
  describe("edge case: total = 0", () => {
    it("returns 'unranked'", () => {
      expect(assignTierByPercentile(0, 0)).toBe("unranked");
    });
  });

  describe("small pools (total < 10)", () => {
    it("rank 0 is always S", () => {
      for (const total of [1, 2, 3, 5, 7, 9]) {
        expect(assignTierByPercentile(0, total)).toBe("S");
      }
    });

    it("rank 1 is always A (when total >= 2)", () => {
      for (const total of [2, 3, 5, 7, 9]) {
        expect(assignTierByPercentile(1, total)).toBe("A");
      }
    });

    it("assigns B tier correctly for total = 5", () => {
      // rank < ceil(5 * 0.6) = ceil(3) = 3 -> ranks 2 are B
      expect(assignTierByPercentile(2, 5)).toBe("B");
    });

    it("assigns C tier correctly for total = 5", () => {
      // rank < ceil(5 * 0.85) = ceil(4.25) = 5 -> ranks 3,4 are C
      expect(assignTierByPercentile(3, 5)).toBe("C");
      expect(assignTierByPercentile(4, 5)).toBe("C");
    });

    it("assigns D tier for last ranks in total = 9", () => {
      // rank < ceil(9 * 0.85) = ceil(7.65) = 8 -> ranks 0-7 are not D
      // rank 8 -> D
      expect(assignTierByPercentile(8, 9)).toBe("D");
    });

    it("total = 1: only rank 0, gets S", () => {
      expect(assignTierByPercentile(0, 1)).toBe("S");
    });

    it("total = 2: rank 0 = S, rank 1 = A", () => {
      expect(assignTierByPercentile(0, 2)).toBe("S");
      expect(assignTierByPercentile(1, 2)).toBe("A");
    });

    it("total = 3: covers S, A, C tiers", () => {
      expect(assignTierByPercentile(0, 3)).toBe("S");
      expect(assignTierByPercentile(1, 3)).toBe("A");
      // rank 2: < ceil(3 * 0.6) = ceil(1.8) = 2? No, 2 is not < 2 -> check C
      // rank 2: < ceil(3 * 0.85) = ceil(2.55) = 3? Yes -> C
      expect(assignTierByPercentile(2, 3)).toBe("C");
    });
  });

  describe("large pools (total >= 10)", () => {
    const total = 100;

    it("top 10% (rank 0-9) -> S tier", () => {
      expect(assignTierByPercentile(0, total)).toBe("S");
      expect(assignTierByPercentile(9, total)).toBe("S");
    });

    it("10%-30% (rank 10-29) -> A tier", () => {
      expect(assignTierByPercentile(10, total)).toBe("A");
      expect(assignTierByPercentile(29, total)).toBe("A");
    });

    it("30%-60% (rank 30-59) -> B tier", () => {
      expect(assignTierByPercentile(30, total)).toBe("B");
      expect(assignTierByPercentile(59, total)).toBe("B");
    });

    it("60%-85% (rank 60-84) -> C tier", () => {
      expect(assignTierByPercentile(60, total)).toBe("C");
      expect(assignTierByPercentile(84, total)).toBe("C");
    });

    it("bottom 15% (rank 85-99) -> D tier", () => {
      expect(assignTierByPercentile(85, total)).toBe("D");
      expect(assignTierByPercentile(99, total)).toBe("D");
    });

    it("all five tiers are represented for 100 agents", () => {
      const tiers = new Set<string>();
      for (let rank = 0; rank < total; rank++) {
        tiers.add(assignTierByPercentile(rank, total));
      }
      expect(tiers).toEqual(new Set(["S", "A", "B", "C", "D"]));
    });
  });

  describe("boundary precision at total = 10 (the transition point)", () => {
    it("rank 0 -> S (0/10 = 0.0 < 0.10)", () => {
      expect(assignTierByPercentile(0, 10)).toBe("S");
    });

    it("rank 1 -> A (1/10 = 0.10, not < 0.10)", () => {
      expect(assignTierByPercentile(1, 10)).toBe("A");
    });

    it("rank 3 -> B (3/10 = 0.30, not < 0.30)", () => {
      expect(assignTierByPercentile(3, 10)).toBe("B");
    });

    it("rank 6 -> C (6/10 = 0.60, not < 0.60)", () => {
      expect(assignTierByPercentile(6, 10)).toBe("C");
    });

    it("rank 9 -> D (9/10 = 0.90, not < 0.85)", () => {
      expect(assignTierByPercentile(9, 10)).toBe("D");
    });
  });
});
