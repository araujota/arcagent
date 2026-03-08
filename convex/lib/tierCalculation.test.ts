import { describe, it, expect } from "vitest";
import {
  TRUST_SCORE_WEIGHTS,
  TIER_RANK,
  MIN_COMPLETED_BOUNTIES,
  MIN_UNIQUE_RATERS,
  MIN_TIER_ELIGIBLE_REWARD,
  SAME_CREATOR_30D_LIMIT,
  CONCENTRATION_CAP_THRESHOLD,
  TURNAROUND_TARGET_MS,
  timeDecayWeight,
  rewardWeight,
  normalizeTurnaroundSpeed,
  computeTrustScore,
  getConfidenceLevel,
  assignTierFromTrustScore,
} from "./tierCalculation";

describe("constants", () => {
  it("TRUST_SCORE_WEIGHTS sum to 1.0", () => {
    const sum = Object.values(TRUST_SCORE_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 10);
  });

  it("TRUST_SCORE_WEIGHTS has the expected values", () => {
    expect(TRUST_SCORE_WEIGHTS).toEqual({
      mergeReadiness: 0.35,
      verificationReliability: 0.25,
      claimReliability: 0.2,
      codeAndTestQuality: 0.1,
      turnaroundSpeed: 0.1,
    });
  });

  it("other constants keep expected guardrails", () => {
    expect(TIER_RANK.S).toBe(5);
    expect(MIN_COMPLETED_BOUNTIES).toBe(5);
    expect(MIN_UNIQUE_RATERS).toBe(3);
    expect(MIN_TIER_ELIGIBLE_REWARD).toBe(50);
    expect(SAME_CREATOR_30D_LIMIT).toBe(3);
    expect(CONCENTRATION_CAP_THRESHOLD).toBe(0.6);
    expect(TURNAROUND_TARGET_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe("timeDecayWeight", () => {
  it("returns 1.0 at age 0", () => {
    expect(timeDecayWeight(0)).toBe(1.0);
  });

  it("returns approximately 0.5 at the half-life", () => {
    const halfLifeDays = Math.LN2 / 0.01;
    const halfLifeMs = halfLifeDays * 24 * 60 * 60 * 1000;
    expect(timeDecayWeight(halfLifeMs)).toBeCloseTo(0.5, 5);
  });
});

describe("rewardWeight", () => {
  it("weights higher-value bounties more heavily", () => {
    expect(rewardWeight(25)).toBe(1);
    expect(rewardWeight(100)).toBeGreaterThan(rewardWeight(25));
    expect(rewardWeight(500)).toBeGreaterThan(rewardWeight(100));
  });
});

describe("normalizeTurnaroundSpeed", () => {
  it("rewards faster resolutions against a fixed 24-hour target", () => {
    expect(normalizeTurnaroundSpeed(0)).toBe(0);
    expect(normalizeTurnaroundSpeed(TURNAROUND_TARGET_MS / 2)).toBeCloseTo(50, 5);
    expect(normalizeTurnaroundSpeed(TURNAROUND_TARGET_MS)).toBe(0);
    expect(normalizeTurnaroundSpeed(TURNAROUND_TARGET_MS * 2)).toBe(0);
  });
});

describe("getConfidenceLevel", () => {
  it("returns high only for broad, deep track records", () => {
    expect(getConfidenceLevel(25, 8)).toBe("high");
    expect(getConfidenceLevel(30, 10)).toBe("high");
  });

  it("returns medium for mid-range evidence", () => {
    expect(getConfidenceLevel(10, 5)).toBe("medium");
    expect(getConfidenceLevel(24, 7)).toBe("medium");
  });

  it("returns low otherwise", () => {
    expect(getConfidenceLevel(5, 3)).toBe("low");
    expect(getConfidenceLevel(12, 4)).toBe("low");
    expect(getConfidenceLevel(26, 7)).toBe("low");
  });
});

describe("computeTrustScore", () => {
  it("reflects the configured component weights", () => {
    const score = computeTrustScore({
      avgMergeReadinessRating: 5,
      verificationReliabilityRate: 1,
      claimReliabilityRate: 1,
      avgCodeQualityRating: 5,
      avgTestCoverageRating: 5,
      avgTimeToResolutionMs: TURNAROUND_TARGET_MS / 2,
    });

    expect(score).toBeCloseTo(95, 5);
  });

  it("does not depend on creator-configured claim duration", () => {
    const fast = computeTrustScore({
      avgMergeReadinessRating: 4.6,
      verificationReliabilityRate: 0.8,
      claimReliabilityRate: 0.9,
      avgCodeQualityRating: 4.5,
      avgTestCoverageRating: 4.2,
      avgTimeToResolutionMs: 2 * 60 * 60 * 1000,
    });
    const sameTime = computeTrustScore({
      avgMergeReadinessRating: 4.6,
      verificationReliabilityRate: 0.8,
      claimReliabilityRate: 0.9,
      avgCodeQualityRating: 4.5,
      avgTestCoverageRating: 4.2,
      avgTimeToResolutionMs: 2 * 60 * 60 * 1000,
    });

    expect(fast).toBeCloseTo(sameTime, 10);
  });
});

describe("assignTierFromTrustScore", () => {
  it("keeps insufficient evidence unranked", () => {
    expect(
      assignTierFromTrustScore({
        totalBountiesCompleted: 4,
        eligibleUniqueRaters: 3,
        trustScore: 99,
        avgMergeReadinessRating: 5,
        claimReliabilityRate: 1,
        verificationReliabilityRate: 1,
        confidenceLevel: "high",
      }),
    ).toBe("unranked");
  });

  it("assigns D and C tiers from thresholds", () => {
    expect(
      assignTierFromTrustScore({
        totalBountiesCompleted: 6,
        eligibleUniqueRaters: 3,
        trustScore: 59,
        avgMergeReadinessRating: 4,
        claimReliabilityRate: 0.8,
        verificationReliabilityRate: 0.7,
        confidenceLevel: "low",
      }),
    ).toBe("D");

    expect(
      assignTierFromTrustScore({
        totalBountiesCompleted: 6,
        eligibleUniqueRaters: 3,
        trustScore: 65,
        avgMergeReadinessRating: 4,
        claimReliabilityRate: 0.8,
        verificationReliabilityRate: 0.7,
        confidenceLevel: "low",
      }),
    ).toBe("C");
  });

  it("requires merge readiness for B tier", () => {
    expect(
      assignTierFromTrustScore({
        totalBountiesCompleted: 8,
        eligibleUniqueRaters: 4,
        trustScore: 75,
        avgMergeReadinessRating: 3.9,
        claimReliabilityRate: 0.8,
        verificationReliabilityRate: 0.7,
        confidenceLevel: "low",
      }),
    ).toBe("B");

    expect(
      assignTierFromTrustScore({
        totalBountiesCompleted: 8,
        eligibleUniqueRaters: 4,
        trustScore: 75,
        avgMergeReadinessRating: 3.6,
        claimReliabilityRate: 0.8,
        verificationReliabilityRate: 0.7,
        confidenceLevel: "low",
      }),
    ).toBe("C");
  });

  it("requires stronger reliability for A tier", () => {
    expect(
      assignTierFromTrustScore({
        totalBountiesCompleted: 14,
        eligibleUniqueRaters: 6,
        trustScore: 85,
        avgMergeReadinessRating: 4.3,
        claimReliabilityRate: 0.8,
        verificationReliabilityRate: 0.6,
        confidenceLevel: "medium",
      }),
    ).toBe("A");

    expect(
      assignTierFromTrustScore({
        totalBountiesCompleted: 14,
        eligibleUniqueRaters: 6,
        trustScore: 85,
        avgMergeReadinessRating: 4.1,
        claimReliabilityRate: 0.8,
        verificationReliabilityRate: 0.6,
        confidenceLevel: "medium",
      }),
    ).toBe("B");
  });

  it("prevents best-of-one S-tier behavior", () => {
    expect(
      assignTierFromTrustScore({
        totalBountiesCompleted: 5,
        eligibleUniqueRaters: 3,
        trustScore: 99,
        avgMergeReadinessRating: 5,
        claimReliabilityRate: 1,
        verificationReliabilityRate: 1,
        confidenceLevel: "low",
      }),
    ).not.toBe("S");

    expect(
      assignTierFromTrustScore({
        totalBountiesCompleted: 25,
        eligibleUniqueRaters: 8,
        trustScore: 95,
        avgMergeReadinessRating: 4.8,
        claimReliabilityRate: 0.92,
        verificationReliabilityRate: 0.82,
        confidenceLevel: "high",
      }),
    ).toBe("S");
  });
});
