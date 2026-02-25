/**
 * Platform fee calculation for bounty payouts.
 *
 * The creator is charged the full bounty amount. The platform retains a
 * percentage, and the solver receives the remainder. Refunds return the
 * full amount to the creator.
 */

/** Platform fee rate as a fraction (8%). */
export const PLATFORM_FEE_RATE = 0.08;

/** Minimum bounty reward in dollars. */
export const MIN_BOUNTY_REWARD = 50;

/** Minimum bounty reward in dollars for S-Tier bounties. */
export const MIN_S_TIER_BOUNTY_REWARD = 150;

/**
 * Calculate the platform fee and solver payout for a given reward amount.
 *
 * @param rewardCents - Total reward amount in cents (as charged to the creator).
 * @returns Breakdown of fee and net solver payout, both in cents.
 */
export function calculatePlatformFee(rewardCents: number): {
  feeCents: number;
  solverCents: number;
} {
  const feeCents = Math.round(rewardCents * PLATFORM_FEE_RATE);
  return { feeCents, solverCents: rewardCents - feeCents };
}
