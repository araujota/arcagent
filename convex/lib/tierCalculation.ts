/**
 * Shared scoring helpers for agent trust calculation and tier assignment.
 * Used by convex/agentStats.ts for trust score computation.
 */

import type { ConfidenceLevel } from "./agentSpecializations";

export const TIER_RANK: Record<string, number> = {
  S: 5,
  A: 4,
  B: 3,
  C: 2,
  D: 1,
  unranked: 0,
};

export type TierLevel = "S" | "A" | "B" | "C" | "D" | "unranked";

/** Minimum thresholds for tier eligibility */
export const MIN_COMPLETED_BOUNTIES = 5;
export const MIN_UNIQUE_RATERS = 3;
export const MIN_TRUSTED_UNIQUE_RATERS = MIN_UNIQUE_RATERS;

/** Minimum bounty reward (USD) for a rating to count toward tier */
export const MIN_TIER_ELIGIBLE_REWARD = 50;
export const MIN_PAID_PAYOUT_VOLUME_USD = 500;

/** Max ratings from same creator in 30-day window that count toward tier */
export const SAME_CREATOR_30D_LIMIT = 3;

/** Single-creator concentration cap — agents above this are capped at B-tier */
export const CONCENTRATION_CAP_THRESHOLD = 0.6;

/** Trust score weights */
export const TRUST_SCORE_WEIGHTS = {
  mergeReadiness: 0.35,
  verificationReliability: 0.25,
  claimReliability: 0.20,
  codeAndTestQuality: 0.10,
  turnaroundSpeed: 0.10,
};

export const TURNAROUND_TARGET_MS = 24 * 60 * 60 * 1000;

/**
 * Exponential time decay with half-life ~69 days.
 * weight = e^(-0.01 * ageInDays)
 */
export function timeDecayWeight(ageMs: number): number {
  const ageInDays = ageMs / (1000 * 60 * 60 * 24);
  return Math.exp(-0.01 * ageInDays);
}

/**
 * Reward-based weight for ratings.
 * weight = log2(bountyReward / 25 + 1)
 * $25 → 1.0, $100 → ~2.3, $500 → ~4.4
 */
export function rewardWeight(bountyReward: number): number {
  return Math.log2(bountyReward / 25 + 1);
}

export function normalizeFivePointRating(value: number): number {
  if (value <= 0) return 0;
  return Math.max(0, Math.min(100, (value / 5) * 100));
}

export function normalizeTurnaroundSpeed(avgTimeToResolutionMs: number): number {
  if (avgTimeToResolutionMs <= 0) return 0;
  return Math.max(
    0,
    Math.min(100, (1 - avgTimeToResolutionMs / TURNAROUND_TARGET_MS) * 100),
  );
}

export function getConfidenceLevel(
  totalBountiesCompleted: number,
  eligibleUniqueRaters: number,
): ConfidenceLevel {
  if (totalBountiesCompleted >= 25 && eligibleUniqueRaters >= 8) return "high";
  if (
    totalBountiesCompleted >= 10 &&
    totalBountiesCompleted <= 24 &&
    eligibleUniqueRaters >= 5 &&
    eligibleUniqueRaters <= 7
  ) {
    return "medium";
  }
  return "low";
}

export function computeTrustScore(inputs: {
  avgMergeReadinessRating: number;
  verificationReliabilityRate: number;
  claimReliabilityRate: number;
  avgCodeQualityRating: number;
  avgTestCoverageRating: number;
  avgTimeToResolutionMs: number;
}): number {
  const mergeReadinessScore = normalizeFivePointRating(inputs.avgMergeReadinessRating);
  const verificationReliabilityScore = Math.max(
    0,
    Math.min(100, inputs.verificationReliabilityRate * 100),
  );
  const claimReliabilityScore = Math.max(
    0,
    Math.min(100, inputs.claimReliabilityRate * 100),
  );
  const codeAndTestQualityScore =
    normalizeFivePointRating(inputs.avgCodeQualityRating) * 0.6 +
    normalizeFivePointRating(inputs.avgTestCoverageRating) * 0.4;
  const turnaroundSpeedScore = normalizeTurnaroundSpeed(inputs.avgTimeToResolutionMs);

  return (
    mergeReadinessScore * TRUST_SCORE_WEIGHTS.mergeReadiness +
    verificationReliabilityScore * TRUST_SCORE_WEIGHTS.verificationReliability +
    claimReliabilityScore * TRUST_SCORE_WEIGHTS.claimReliability +
    codeAndTestQualityScore * TRUST_SCORE_WEIGHTS.codeAndTestQuality +
    turnaroundSpeedScore * TRUST_SCORE_WEIGHTS.turnaroundSpeed
  );
}

export function assignTierFromTrustScore(args: {
  totalBountiesCompleted: number;
  eligibleUniqueRaters: number;
  trustScore: number;
  avgMergeReadinessRating: number;
  claimReliabilityRate: number;
  verificationReliabilityRate: number;
  confidenceLevel: ConfidenceLevel;
}): TierLevel {
  if (
    args.totalBountiesCompleted < MIN_COMPLETED_BOUNTIES ||
    args.eligibleUniqueRaters < MIN_UNIQUE_RATERS
  ) {
    return "unranked";
  }

  if (
    args.trustScore >= 90 &&
    args.avgMergeReadinessRating >= 4.6 &&
    args.claimReliabilityRate >= 0.9 &&
    args.verificationReliabilityRate >= 0.8 &&
    args.confidenceLevel === "high" &&
    args.totalBountiesCompleted >= 25
  ) {
    return "S";
  }

  if (
    args.trustScore >= 80 &&
    args.avgMergeReadinessRating >= 4.2 &&
    args.claimReliabilityRate >= 0.8 &&
    args.verificationReliabilityRate >= 0.6
  ) {
    return "A";
  }

  if (args.trustScore >= 70 && args.avgMergeReadinessRating >= 3.8) {
    return "B";
  }

  if (args.trustScore >= 60) {
    return "C";
  }

  return "D";
}
