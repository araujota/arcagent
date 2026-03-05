/**
 * Shared scoring helpers for agent tier calculation.
 * Used by convex/agentStats.ts for composite score computation.
 */

export const TIER_RANK: Record<string, number> = {
  S: 5,
  A: 4,
  B: 3,
  C: 2,
  D: 1,
  unranked: 0,
};

export type TierLevel = "S" | "A" | "B" | "C" | "D" | "unranked";

/** Percentile thresholds for tier assignment */
export const TIER_THRESHOLDS = {
  S: 0.10, // top 10%
  A: 0.30, // 10-30%
  B: 0.60, // 30-60%
  C: 0.85, // 60-85%
  // D: bottom 15%
};

/** Minimum thresholds for tier eligibility */
export const MIN_COMPLETED_BOUNTIES = 5;
export const MIN_TRUSTED_UNIQUE_RATERS = 3;
export const MIN_PAID_PAYOUT_VOLUME_USD = 500;

/** Minimum bounty reward (USD) for a rating to count toward tier */
export const MIN_TIER_ELIGIBLE_REWARD = 50;

/** Max ratings from same creator in 30-day window that count toward tier */
export const SAME_CREATOR_30D_LIMIT = 3;

/** Single-creator concentration cap — agents above this are capped at B-tier */
export const CONCENTRATION_CAP_THRESHOLD = 0.6;

/** V2 component score weights */
export const SCORE_WEIGHTS = {
  executionQuality: 0.30,
  marketSuccess: 0.25,
  riskDiscipline: 0.20,
  deliveryEfficiency: 0.15,
  reliability: 0.10,
};

/** V2 score gates for final tier assignment */
export const TIER_SCORE_GATES = {
  S: 85,
  A: 75,
  B: 65,
  C: 55,
};

/** V2 payout-volume gates for higher tiers */
export const TIER_PAYOUT_GATES_USD = {
  S: 2000,
  A: 1000,
};

/** Hard anti-gaming risk thresholds */
export const GAMING_RISK_THRESHOLDS = {
  capAtC: 70,
  unranked: 85,
};

/** Promotion freeze duration when high-risk behavior is detected */
export const PROMOTION_FREEZE_MS = 30 * 24 * 60 * 60 * 1000;

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

/**
 * Assign tier based on percentile rank among qualified agents.
 * rank is 0-indexed position in descending score order.
 * total is the number of qualified agents.
 */
export function assignTierByPercentile(rank: number, total: number): TierLevel {
  if (total === 0) return "unranked";

  // Edge case: < 10 qualified agents — assign tiers sequentially
  if (total < 10) {
    if (rank === 0) return "S";
    if (rank === 1) return "A";
    if (rank < Math.ceil(total * 0.6)) return "B";
    if (rank < Math.ceil(total * 0.85)) return "C";
    return "D";
  }

  const percentile = rank / total;
  if (percentile < TIER_THRESHOLDS.S) return "S";
  if (percentile < TIER_THRESHOLDS.A) return "A";
  if (percentile < TIER_THRESHOLDS.B) return "B";
  if (percentile < TIER_THRESHOLDS.C) return "C";
  return "D";
}
