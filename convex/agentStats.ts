import { query, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { getCurrentUser, requireAuth } from "./lib/utils";
import { internal } from "./_generated/api";
import {
  timeDecayWeight,
  rewardWeight,
  SCORE_WEIGHTS,
  MIN_COMPLETED_BOUNTIES,
  MIN_TRUSTED_UNIQUE_RATERS,
  MIN_PAID_PAYOUT_VOLUME_USD,
  CONCENTRATION_CAP_THRESHOLD,
  TIER_SCORE_GATES,
  TIER_PAYOUT_GATES_USD,
  GAMING_RISK_THRESHOLDS,
  PROMOTION_FREEZE_MS,
  TIER_RANK,
  MIN_TIER_ELIGIBLE_REWARD,
} from "./lib/tierCalculation";

const ADVISORY_LEGS = new Set([
  "lint_no_new_errors",
  "typecheck_no_new_errors",
  "security_no_new_high_critical",
  "memory",
  "snyk_no_new_high_critical",
  "sonarqube_new_code",
]);

const HIGH_VALUE_BOUNTY_THRESHOLD = 150;
const VOLUME_SCORE_ANCHOR_USD = 5000;
const TRUSTED_RATER_ACCOUNT_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const TRUSTED_RATER_MIN_PAID_COMPLETIONS = 2;

const SECURITY_RELATED_LEGS = new Set([
  "security_no_new_high_critical",
  "snyk_no_new_high_critical",
  "sonarqube_new_code",
]);

type NormalizedReceipt = {
  tool?: "sonarqube" | "snyk";
  counts?: {
    critical?: number;
    high?: number;
    medium?: number;
    low?: number;
    bugs?: number;
    codeSmells?: number;
    complexityDelta?: number;
    introducedTotal?: number;
  };
};

type ScoreBreakdown = {
  executionQuality: number;
  marketSuccess: number;
  riskDiscipline: number;
  deliveryEfficiency: number;
  reliability: number;
  subfactors: {
    bayesianCreatorRating: number;
    firstAttemptPassScore: number;
    hiddenPassScore: number;
    payoutVolumeScore: number;
    repeatCreatorScore: number;
    highValueShareScore: number;
    sonarRiskDisciplineScore: number;
    snykMinorDisciplineScore: number;
    advisoryReliabilityScore: number;
    timeToResolutionScore: number;
    submissionsEfficiencyScore: number;
    completionRateScore: number;
    concentrationRisk: number;
    lowTrustRisk: number;
    reciprocalRisk: number;
    policyRisk: number;
  };
};

function parseNormalizedReceipt(normalizedJson?: string): NormalizedReceipt | null {
  if (!normalizedJson) return null;
  try {
    const parsed = JSON.parse(normalizedJson) as NormalizedReceipt;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function asFinite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function burdenToScore(burden: number, slope: number): number {
  const safeBurden = Math.max(0, burden);
  const penalty = Math.log10(1 + safeBurden) * slope;
  return Math.max(0, 100 - penalty);
}

function toPercent(value: number): number {
  return clamp(value * 100, 0, 100);
}

function computeBayesianRating(weightedAverage: number, trustedCount: number): number {
  const priorRating = 3.5;
  const priorWeight = 5;
  if (trustedCount <= 0) return priorRating;
  return (
    (priorRating * priorWeight + weightedAverage * trustedCount) /
    (priorWeight + trustedCount)
  );
}

function isStatusBlockingOrError(status: string): boolean {
  return status === "fail" || status === "error" || status === "skipped_policy_due_process";
}

async function getCreatorPaidCompletedCount(
  ctx: any,
  creatorId: string,
  creatorPaidCompletionCache: Map<string, number>,
  paymentByBountyCache: Map<string, any>,
): Promise<number> {
  const cached = creatorPaidCompletionCache.get(creatorId);
  if (cached !== undefined) return cached;

  const creatorBounties = await ctx.db
    .query("bounties")
    .withIndex("by_creatorId", (q: any) => q.eq("creatorId", creatorId))
    .collect();

  let count = 0;
  for (const bounty of creatorBounties) {
    if (bounty.isTestBounty) continue;
    if (bounty.status !== "completed") continue;

    let payment = paymentByBountyCache.get(String(bounty._id));
    if (payment === undefined) {
      payment = await ctx.db
        .query("payments")
        .withIndex("by_bountyId", (q: any) => q.eq("bountyId", bounty._id))
        .first();
      paymentByBountyCache.set(String(bounty._id), payment ?? null);
    }

    if (payment && payment.status === "completed" && payment.amount > 0) {
      count++;
    }
  }

  creatorPaidCompletionCache.set(creatorId, count);
  return count;
}

function parseRiskFlags(riskFlagsJson?: string): string[] {
  if (!riskFlagsJson) return [];
  try {
    const parsed = JSON.parse(riskFlagsJson) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((v): v is string => typeof v === "string");
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Recompute all metrics for a single agent.
 * Called after bounty completion or rating submission.
 * Tier is NOT set here — only by the daily cron.
 */
export const recomputeForAgent = internalMutation({
  args: { agentId: v.id("users") },
  handler: async (ctx, args) => {
    const now = Date.now();

    const existing = await ctx.db
      .query("agentStats")
      .withIndex("by_agentId", (q) => q.eq("agentId", args.agentId))
      .unique();

    const paymentByBountyCache = new Map<string, any>();
    const creatorPaidCompletionCache = new Map<string, number>();

    // 1. Fetch claims and enrich with bounty/payment context.
    const allClaims = await ctx.db
      .query("bountyClaims")
      .withIndex("by_agentId", (q) => q.eq("agentId", args.agentId))
      .collect();

    const claimContexts: Array<{
      claim: any;
      bounty: any;
      payment: any | null;
      isNonTest: boolean;
      isPaid: boolean;
    }> = [];

    for (const claim of allClaims) {
      const bounty = await ctx.db.get(claim.bountyId);
      if (!bounty) continue;

      let payment = paymentByBountyCache.get(String(bounty._id));
      if (payment === undefined) {
        payment = await ctx.db
          .query("payments")
          .withIndex("by_bountyId", (q: any) => q.eq("bountyId", bounty._id))
          .first();
        paymentByBountyCache.set(String(bounty._id), payment ?? null);
      }

      const isNonTest = !bounty.isTestBounty;
      const isPaid =
        claim.status === "completed" &&
        isNonTest &&
        !!payment &&
        payment.status === "completed" &&
        payment.recipientId === args.agentId &&
        payment.amount > 0;

      claimContexts.push({ claim, bounty, payment: payment ?? null, isNonTest, isPaid });
    }

    const completedClaims = claimContexts.filter((c) => c.claim.status === "completed");
    const nonTestClosedClaims = claimContexts.filter(
      (c) =>
        c.isNonTest &&
        (c.claim.status === "completed" || c.claim.status === "expired" || c.claim.status === "released"),
    );
    const paidCompletedClaims = claimContexts.filter((c) => c.isPaid);

    const totalBountiesClaimed = claimContexts.length;
    const totalBountiesCompleted = completedClaims.length;
    const totalBountiesExpired = claimContexts.filter((c) => c.claim.status === "expired").length;
    const paidBountiesCompleted = paidCompletedClaims.length;

    const nonTestCompletedCount = nonTestClosedClaims.filter((c) => c.claim.status === "completed").length;
    const completionRate =
      nonTestClosedClaims.length > 0 ? nonTestCompletedCount / nonTestClosedClaims.length : 0;

    let totalSubmissions = 0;
    let totalFirstAttemptPasses = 0;
    let totalGatePasses = 0;
    let totalGateWarnings = 0;
    let advisoryLegAttempts = 0;
    let advisoryProcessFailures = 0;
    let weightedSonarRiskBurdenSum = 0;
    let weightedSonarRiskWeightSum = 0;
    let weightedSnykMinorBurdenSum = 0;
    let weightedSnykMinorWeightSum = 0;
    let observedSonarReceipts = 0;
    let observedSnykReceipts = 0;
    let weightedTimeSum = 0;
    let weightedTimeWeightSum = 0;
    let weightedSpeedRatioSum = 0;
    let weightedSpeedWeightSum = 0;
    let submissionsPerBountySum = 0;
    let hiddenPassCount = 0;
    let hiddenFailCount = 0;
    let policySecurityAnomalyCount = 0;
    let policySecurityObservedCount = 0;

    const paidCreatorCounts = new Map<string, number>();
    let highValueCompletedCount = 0;
    let paidPayoutVolumeUsd = 0;

    for (const { claim, bounty, payment } of paidCompletedClaims) {
      const ageMs = now - claim.claimedAt;
      const decay = timeDecayWeight(ageMs);

      paidPayoutVolumeUsd += payment?.amount ?? 0;
      paidCreatorCounts.set(
        String(bounty.creatorId),
        (paidCreatorCounts.get(String(bounty.creatorId)) ?? 0) + 1,
      );
      if ((bounty.reward ?? 0) >= HIGH_VALUE_BOUNTY_THRESHOLD) {
        highValueCompletedCount++;
      }

      const bountySubmissions = await ctx.db
        .query("submissions")
        .withIndex("by_bountyId", (q) => q.eq("bountyId", claim.bountyId))
        .filter((q) => q.eq(q.field("agentId"), args.agentId))
        .collect();

      totalSubmissions += bountySubmissions.length;
      submissionsPerBountySum += bountySubmissions.length;

      const submissionVerifications = await Promise.all(
        bountySubmissions.map(async (submission) => ({
          submissionId: submission._id,
          verifications: await ctx.db
            .query("verifications")
            .withIndex("by_submissionId", (q) => q.eq("submissionId", submission._id))
            .collect(),
        })),
      );
      const allVerifications = submissionVerifications.flatMap((entry) => entry.verifications);

      const passedVerification = [...allVerifications]
        .filter((v) => v.status === "passed")
        .sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0))[0];

      if (passedVerification?.completedAt) {
        const resolutionMs = passedVerification.completedAt - claim.claimedAt;
        weightedTimeSum += resolutionMs * decay;
        weightedTimeWeightSum += decay;

        const claimDurationMs = (bounty.claimDurationHours ?? 4) * 60 * 60 * 1000;
        const speedRatio = clamp(1 - resolutionMs / claimDurationMs, 0, 1);
        weightedSpeedRatioSum += speedRatio * decay;
        weightedSpeedWeightSum += decay;
      }

      if (bountySubmissions.length > 0) {
        const firstSub = [...bountySubmissions].sort((a, b) => a._creationTime - b._creationTime)[0];
        const firstSubVerifications = await ctx.db
          .query("verifications")
          .withIndex("by_submissionId", (q) => q.eq("submissionId", firstSub._id))
          .collect();
        const firstVerification = [...firstSubVerifications].sort(
          (a, b) => a._creationTime - b._creationTime,
        )[0];
        if (firstVerification?.status === "passed") {
          totalFirstAttemptPasses++;
        }
      }

      for (const verification of allVerifications) {
        const [receipts, steps] = await Promise.all([
          ctx.db
            .query("verificationReceipts")
            .withIndex("by_verificationId_and_orderIndex", (q) =>
              q.eq("verificationId", verification._id),
            )
            .collect(),
          ctx.db
            .query("verificationSteps")
            .withIndex("by_verificationId", (q) => q.eq("verificationId", verification._id))
            .collect(),
        ]);

        if (verification.status === "passed") {
          const gates = await ctx.db
            .query("sanityGates")
            .withIndex("by_verificationId", (q) => q.eq("verificationId", verification._id))
            .collect();
          for (const gate of gates) {
            if (gate.status === "passed") totalGatePasses++;
            if (gate.status === "warning") totalGateWarnings++;
          }
        }

        for (const step of steps) {
          if ((step.visibility ?? "public") !== "hidden") continue;
          if (step.status === "pass") hiddenPassCount++;
          if (step.status === "fail" || step.status === "error") hiddenFailCount++;
        }

        for (const receipt of receipts) {
          if (receipt.status !== "unreached") {
            policySecurityObservedCount++;
          }

          if (ADVISORY_LEGS.has(receipt.legKey) && receipt.status !== "unreached") {
            advisoryLegAttempts++;
            if (receipt.status === "error" || receipt.status === "skipped_policy_due_process") {
              advisoryProcessFailures++;
            }
          }

          if (
            isStatusBlockingOrError(receipt.status) &&
            (SECURITY_RELATED_LEGS.has(receipt.legKey) || receipt.status === "skipped_policy_due_process")
          ) {
            policySecurityAnomalyCount++;
          }

          if (receipt.legKey === "sonarqube_new_code") {
            const normalized = parseNormalizedReceipt(receipt.normalizedJson);
            if (normalized?.tool === "sonarqube") {
              const counts = normalized.counts ?? {};
              const sonarBurden =
                asFinite(counts.bugs) +
                asFinite(counts.codeSmells) +
                asFinite(counts.complexityDelta);
              weightedSonarRiskBurdenSum += sonarBurden * decay;
              weightedSonarRiskWeightSum += decay;
              observedSonarReceipts++;
            }
          }

          if (receipt.legKey === "snyk_no_new_high_critical") {
            const normalized = parseNormalizedReceipt(receipt.normalizedJson);
            if (normalized?.tool === "snyk") {
              const counts = normalized.counts ?? {};
              const minorBurden = asFinite(counts.medium) + asFinite(counts.low);
              weightedSnykMinorBurdenSum += minorBurden * decay;
              weightedSnykMinorWeightSum += decay;
              observedSnykReceipts++;
            }
          }
        }
      }
    }

    const avgTimeToResolutionMs =
      weightedTimeWeightSum > 0 ? weightedTimeSum / weightedTimeWeightSum : 0;
    const avgSubmissionsPerBounty =
      paidBountiesCompleted > 0 ? submissionsPerBountySum / paidBountiesCompleted : 0;
    const firstAttemptPassRate =
      paidBountiesCompleted > 0 ? totalFirstAttemptPasses / paidBountiesCompleted : 0;

    const totalGates = totalGatePasses + totalGateWarnings;
    const gateQualityScore = totalGates > 0 ? totalGatePasses / totalGates : 0;
    const advisoryProcessFailureRate =
      advisoryLegAttempts > 0 ? advisoryProcessFailures / advisoryLegAttempts : 0;

    const sonarRiskBurden =
      weightedSonarRiskWeightSum > 0 ? weightedSonarRiskBurdenSum / weightedSonarRiskWeightSum : 0;
    const snykMinorBurden =
      weightedSnykMinorWeightSum > 0 ? weightedSnykMinorBurdenSum / weightedSnykMinorWeightSum : 0;

    const hiddenObserved = hiddenPassCount + hiddenFailCount;
    const hiddenPassRate = hiddenObserved > 0 ? hiddenPassCount / hiddenObserved : 0;
    const policySecurityAnomalyRate =
      policySecurityObservedCount > 0
        ? policySecurityAnomalyCount / policySecurityObservedCount
        : 0;

    // 3. Rating aggregates (trusted + paid + non-test)
    const allRatings = await ctx.db
      .query("agentRatings")
      .withIndex("by_agentId", (q) => q.eq("agentId", args.agentId))
      .collect();

    let weightedRatingSum = 0;
    let ratingWeightSum = 0;
    let trustedEligibleRatingCount = 0;
    let eligibleRatingCount = 0;
    let lowTrustEligibleRatingCount = 0;

    const trustedCreatorIds = new Set<string>();
    const creatorCounts = new Map<string, number>();
    const trustedWeightByCreator = new Map<string, number>();

    for (const r of allRatings) {
      const creatorId = String(r.creatorId);
      creatorCounts.set(creatorId, (creatorCounts.get(creatorId) ?? 0) + 1);

      const bounty = await ctx.db.get(r.bountyId);
      if (!bounty) continue;
      if (bounty.isTestBounty) continue;
      if (!r.tierEligible) continue;
      if ((bounty.reward ?? 0) < MIN_TIER_ELIGIBLE_REWARD) continue;

      const creator = await ctx.db.get(r.creatorId);
      const creatorAccountAgeMs = creator ? now - creator._creationTime : 0;
      const creatorPaidCompletedCount = creator
        ? await getCreatorPaidCompletedCount(
            ctx,
            creatorId,
            creatorPaidCompletionCache,
            paymentByBountyCache,
          )
        : 0;
      const trusted =
        !!creator &&
        creatorAccountAgeMs >= TRUSTED_RATER_ACCOUNT_AGE_MS &&
        creatorPaidCompletedCount >= TRUSTED_RATER_MIN_PAID_COMPLETIONS;

      eligibleRatingCount++;

      if (!trusted) {
        lowTrustEligibleRatingCount++;
        continue;
      }

      trustedCreatorIds.add(creatorId);
      trustedEligibleRatingCount++;

      const dimAvg =
        (r.codeQuality + r.speed + r.mergedWithoutChanges + r.communication + r.testCoverage) / 5;
      const ageMs = now - r.createdAt;
      const decay = timeDecayWeight(ageMs);
      const rw = rewardWeight(bounty.reward);
      const weight = rw * decay;

      weightedRatingSum += dimAvg * weight;
      ratingWeightSum += weight;
      trustedWeightByCreator.set(creatorId, (trustedWeightByCreator.get(creatorId) ?? 0) + weight);
    }

    const totalRatings = allRatings.length;
    const uniqueRaters = creatorCounts.size;
    const trustedUniqueRaters = trustedCreatorIds.size;

    const totalTrustedWeight = Array.from(trustedWeightByCreator.values()).reduce((acc, n) => acc + n, 0);
    const maxTrustedCreatorWeight = Math.max(0, ...Array.from(trustedWeightByCreator.values()));
    const singleCreatorConcentration =
      totalTrustedWeight > 0 ? maxTrustedCreatorWeight / totalTrustedWeight : 0;

    const lowTrustCreatorShare =
      eligibleRatingCount > 0 ? lowTrustEligibleRatingCount / eligibleRatingCount : 0;

    const avgCreatorRating = ratingWeightSum > 0 ? weightedRatingSum / ratingWeightSum : 0;

    // 4. V2 components and risk model
    const bayesianCreatorRating = computeBayesianRating(avgCreatorRating, trustedEligibleRatingCount);
    const bayesianCreatorRatingScore = toPercent(bayesianCreatorRating / 5);

    const firstAttemptPassScore = paidBountiesCompleted > 0 ? toPercent(firstAttemptPassRate) : 50;
    const hiddenPassScore = hiddenObserved > 0 ? toPercent(hiddenPassRate) : 50;

    const sonarRiskDisciplineScore =
      observedSonarReceipts > 0 ? burdenToScore(sonarRiskBurden, 45) : 50;
    const snykMinorDisciplineScore =
      observedSnykReceipts > 0 ? burdenToScore(snykMinorBurden, 60) : 50;
    const advisoryReliabilityScore =
      advisoryLegAttempts > 0 ? Math.max(0, (1 - advisoryProcessFailureRate) * 100) : 50;

    const timeToResolutionScore =
      weightedSpeedWeightSum > 0 ? toPercent(weightedSpeedRatioSum / weightedSpeedWeightSum) : 50;
    const submissionsEfficiencyScore =
      avgSubmissionsPerBounty > 0
        ? clamp(100 - Math.max(0, avgSubmissionsPerBounty - 1) * 30, 0, 100)
        : 50;

    const repeatCreatorCount = Array.from(paidCreatorCounts.values()).filter((n) => n >= 2).length;
    const repeatCreatorHireRate =
      paidCreatorCounts.size > 0 ? repeatCreatorCount / paidCreatorCounts.size : 0;
    const highValueCompletionRate =
      paidBountiesCompleted > 0 ? highValueCompletedCount / paidBountiesCompleted : 0;

    const payoutVolumeScore =
      paidPayoutVolumeUsd > 0
        ? clamp(
            (Math.log1p(paidPayoutVolumeUsd) / Math.log1p(VOLUME_SCORE_ANCHOR_USD)) * 100,
            0,
            100,
          )
        : 0;

    const completionRateScore =
      nonTestClosedClaims.length > 0 ? toPercent(completionRate) : 50;

    const executionQuality =
      bayesianCreatorRatingScore * 0.5 + firstAttemptPassScore * 0.3 + hiddenPassScore * 0.2;

    const marketSuccess =
      payoutVolumeScore * 0.5 +
      toPercent(repeatCreatorHireRate) * 0.3 +
      toPercent(highValueCompletionRate) * 0.2;

    const riskDiscipline =
      sonarRiskDisciplineScore * 0.4 +
      snykMinorDisciplineScore * 0.35 +
      advisoryReliabilityScore * 0.25;

    const deliveryEfficiency = timeToResolutionScore * 0.6 + submissionsEfficiencyScore * 0.4;
    const reliability = completionRateScore;

    const weightedScore =
      executionQuality * SCORE_WEIGHTS.executionQuality +
      marketSuccess * SCORE_WEIGHTS.marketSuccess +
      riskDiscipline * SCORE_WEIGHTS.riskDiscipline +
      deliveryEfficiency * SCORE_WEIGHTS.deliveryEfficiency +
      reliability * SCORE_WEIGHTS.reliability;

    const reciprocalCreatorIds = new Set<string>();
    if (paidCreatorCounts.size > 0) {
      const agentCreatedBounties = await ctx.db
        .query("bounties")
        .withIndex("by_creatorId", (q: any) => q.eq("creatorId", args.agentId))
        .collect();

      for (const bounty of agentCreatedBounties) {
        if (bounty.isTestBounty) continue;
        if (bounty.status !== "completed") continue;

        let payment = paymentByBountyCache.get(String(bounty._id));
        if (payment === undefined) {
          payment = await ctx.db
            .query("payments")
            .withIndex("by_bountyId", (q: any) => q.eq("bountyId", bounty._id))
            .first();
          paymentByBountyCache.set(String(bounty._id), payment ?? null);
        }
        if (!payment || payment.status !== "completed" || payment.amount <= 0) continue;

        const recipientId = String(payment.recipientId);
        if (paidCreatorCounts.has(recipientId)) {
          reciprocalCreatorIds.add(recipientId);
        }
      }
    }

    const reciprocalRate =
      paidCreatorCounts.size > 0 ? reciprocalCreatorIds.size / paidCreatorCounts.size : 0;

    const concentrationRisk = clamp(((singleCreatorConcentration - 0.35) / 0.35) * 100, 0, 100);
    const lowTrustRisk = toPercent(lowTrustCreatorShare);
    const reciprocalRisk = toPercent(reciprocalRate);
    const policyRisk = toPercent(policySecurityAnomalyRate);

    const gamingRiskScore = clamp(
      concentrationRisk * 0.4 + lowTrustRisk * 0.25 + reciprocalRisk * 0.2 + policyRisk * 0.15,
      0,
      100,
    );

    let penaltyScore = 0;
    if (gamingRiskScore > GAMING_RISK_THRESHOLDS.capAtC) {
      penaltyScore += 20;
    }

    let promotionFreezeUntilMs = existing?.promotionFreezeUntilMs;
    if (gamingRiskScore > GAMING_RISK_THRESHOLDS.unranked) {
      promotionFreezeUntilMs = now + PROMOTION_FREEZE_MS;
    }
    if (promotionFreezeUntilMs && promotionFreezeUntilMs <= now) {
      promotionFreezeUntilMs = undefined;
    }

    const finalScore = clamp(weightedScore - penaltyScore, 0, 100);

    const riskFlags: string[] = [];
    if (singleCreatorConcentration > CONCENTRATION_CAP_THRESHOLD) {
      riskFlags.push("single_creator_concentration_high");
    }
    if (lowTrustCreatorShare > 0.5) {
      riskFlags.push("low_trust_creator_share_high");
    }
    if (reciprocalRate > 0.3) {
      riskFlags.push("reciprocal_creator_link_pattern");
    }
    if (policySecurityAnomalyRate > 0.2) {
      riskFlags.push("policy_security_anomaly_rate_high");
    }
    if (gamingRiskScore > GAMING_RISK_THRESHOLDS.capAtC) {
      riskFlags.push("gaming_risk_cap_c");
    }
    if (gamingRiskScore > GAMING_RISK_THRESHOLDS.unranked) {
      riskFlags.push("gaming_risk_unranked");
    }
    if (promotionFreezeUntilMs && promotionFreezeUntilMs > now) {
      riskFlags.push("promotion_frozen");
    }

    const scoreBreakdown: ScoreBreakdown = {
      executionQuality,
      marketSuccess,
      riskDiscipline,
      deliveryEfficiency,
      reliability,
      subfactors: {
        bayesianCreatorRating: bayesianCreatorRatingScore,
        firstAttemptPassScore,
        hiddenPassScore,
        payoutVolumeScore,
        repeatCreatorScore: toPercent(repeatCreatorHireRate),
        highValueShareScore: toPercent(highValueCompletionRate),
        sonarRiskDisciplineScore,
        snykMinorDisciplineScore,
        advisoryReliabilityScore,
        timeToResolutionScore,
        submissionsEfficiencyScore,
        completionRateScore,
        concentrationRisk,
        lowTrustRisk,
        reciprocalRisk,
        policyRisk,
      },
    };

    const statsData = {
      agentId: args.agentId,
      totalBountiesCompleted,
      totalBountiesClaimed,
      totalBountiesExpired,
      paidBountiesCompleted,
      paidPayoutVolumeUsd,
      totalSubmissions,
      totalFirstAttemptPasses,
      totalGateWarnings,
      totalGatePasses,
      avgTimeToResolutionMs,
      avgSubmissionsPerBounty,
      firstAttemptPassRate,
      completionRate,
      gateQualityScore,
      sonarRiskBurden,
      snykMinorBurden,
      advisoryProcessFailureRate,
      sonarRiskDisciplineScore,
      snykMinorDisciplineScore,
      advisoryReliabilityScore,
      avgCreatorRating,
      totalRatings,
      uniqueRaters,
      trustedUniqueRaters,
      singleCreatorConcentration,
      lowTrustCreatorShare,
      repeatCreatorHireRate,
      highValueCompletionRate,
      hiddenPassRate,
      gamingRiskScore,
      weightedScore,
      penaltyScore,
      finalScore,
      promotionFreezeUntilMs,
      scoreVersion: "v2",
      scoreBreakdownJson: JSON.stringify(scoreBreakdown),
      riskFlagsJson: JSON.stringify(riskFlags),
      compositeScore: finalScore,
      tier: existing?.tier ?? ("unranked" as const),
      lastComputedAt: now,
    };

    if (existing) {
      await ctx.db.patch(existing._id, statsData);
    } else {
      await ctx.db.insert("agentStats", statsData);
    }
  },
});

function isTierQualificationEligible(stats: any, now: number): boolean {
  const freezeActive = !!stats.promotionFreezeUntilMs && stats.promotionFreezeUntilMs > now;
  const risk = stats.gamingRiskScore ?? 0;
  return (
    (stats.paidBountiesCompleted ?? 0) >= MIN_COMPLETED_BOUNTIES &&
    (stats.trustedUniqueRaters ?? 0) >= MIN_TRUSTED_UNIQUE_RATERS &&
    (stats.paidPayoutVolumeUsd ?? 0) >= MIN_PAID_PAYOUT_VOLUME_USD &&
    !freezeActive &&
    risk <= GAMING_RISK_THRESHOLDS.unranked
  );
}

function compareTierCandidates(a: any, b: any): number {
  const bScore = b.finalScore ?? b.compositeScore;
  const aScore = a.finalScore ?? a.compositeScore;
  if (bScore !== aScore) return bScore - aScore;
  if ((b.paidBountiesCompleted ?? 0) !== (a.paidBountiesCompleted ?? 0)) {
    return (b.paidBountiesCompleted ?? 0) - (a.paidBountiesCompleted ?? 0);
  }
  return b.totalBountiesCompleted - a.totalBountiesCompleted;
}

function computeBaseTier(score: number, percentile: number, payout: number, risk: number): "S" | "A" | "B" | "C" | "D" {
  if (
    score >= TIER_SCORE_GATES.S &&
    percentile < 0.1 &&
    payout >= TIER_PAYOUT_GATES_USD.S &&
    risk <= 10
  ) {
    return "S";
  }
  if (
    score >= TIER_SCORE_GATES.A &&
    percentile < 0.3 &&
    payout >= TIER_PAYOUT_GATES_USD.A &&
    risk <= 15
  ) {
    return "A";
  }
  if (score >= TIER_SCORE_GATES.B && percentile < 0.6) return "B";
  if (score >= TIER_SCORE_GATES.C && percentile < 0.85) return "C";
  return "D";
}

function applyTierCaps(baseTier: "S" | "A" | "B" | "C" | "D", stats: any): "S" | "A" | "B" | "C" | "D" {
  const risk = stats.gamingRiskScore ?? 0;
  let tier = baseTier;
  if (risk > GAMING_RISK_THRESHOLDS.capAtC && TIER_RANK[tier] > TIER_RANK.C) {
    tier = "C";
  }
  if ((stats.singleCreatorConcentration ?? 0) > CONCENTRATION_CAP_THRESHOLD && (tier === "S" || tier === "A")) {
    tier = "B";
  }
  return tier;
}

function shouldBeUnranked(stats: any, now: number): boolean {
  const freezeActive = !!stats.promotionFreezeUntilMs && stats.promotionFreezeUntilMs > now;
  return (
    (stats.paidBountiesCompleted ?? 0) < MIN_COMPLETED_BOUNTIES ||
    (stats.trustedUniqueRaters ?? 0) < MIN_TRUSTED_UNIQUE_RATERS ||
    (stats.paidPayoutVolumeUsd ?? 0) < MIN_PAID_PAYOUT_VOLUME_USD ||
    freezeActive ||
    (stats.gamingRiskScore ?? 0) > GAMING_RISK_THRESHOLDS.unranked
  );
}

function resolveTierForQualifiedStats(
  stats: any,
  qualified: any[],
): "S" | "A" | "B" | "C" | "D" | "unranked" {
  const index = qualified.findIndex((candidate) => candidate._id === stats._id);
  if (index < 0) return "unranked";

  const percentile = qualified.length > 0 ? index / qualified.length : 1;
  const score = stats.finalScore ?? stats.compositeScore;
  const risk = stats.gamingRiskScore ?? 0;
  const payout = stats.paidPayoutVolumeUsd ?? 0;
  return applyTierCaps(computeBaseTier(score, percentile, payout, risk), stats);
}

async function recomputeTierForAgentRow(ctx: any, agentId: any): Promise<"S" | "A" | "B" | "C" | "D" | "unranked" | null> {
  const now = Date.now();
  const allStats = await ctx.db.query("agentStats").collect();
  const stats = allStats.find((entry) => entry.agentId === agentId);
  if (!stats) return null;

  const nextTier = shouldBeUnranked(stats, now)
    ? "unranked"
    : resolveTierForQualifiedStats(
        stats,
        allStats.filter((entry) => isTierQualificationEligible(entry, now)).sort(compareTierCandidates),
      );

  if (stats.tier !== nextTier) {
    await ctx.db.patch(stats._id, { tier: nextTier });
  }

  return nextTier;
}

/**
 * Recompute all tiers based on V2 ranking and anti-gaming policy.
 * Called by daily cron.
 */
export const recomputeAllTiers = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const allStats = await ctx.db.query("agentStats").collect();
    const qualified = allStats.filter((stats) => isTierQualificationEligible(stats, now));
    qualified.sort(compareTierCandidates);

    for (const stats of qualified) {
      const tier = resolveTierForQualifiedStats(stats, qualified);
      if (stats.tier !== tier) {
        await ctx.db.patch(stats._id, { tier });
      }
    }

    for (const stats of allStats) {
      if (shouldBeUnranked(stats, now) && stats.tier !== "unranked") {
        await ctx.db.patch(stats._id, { tier: "unranked" });
      }
    }
  },
});

export const recomputeTierForAgent = internalMutation({
  args: { agentId: v.id("users") },
  handler: async (ctx, args) => {
    return await recomputeTierForAgentRow(ctx, args.agentId);
  },
});

/**
 * Queue a full V2 backfill and tier recomputation for all agents.
 */
export const backfillV2Stats = internalMutation({
  args: {},
  handler: async (ctx) => {
    const agents = await ctx.db
      .query("users")
      .withIndex("by_role", (q) => q.eq("role", "agent"))
      .collect();

    for (const agent of agents) {
      await ctx.scheduler.runAfter(0, internal.agentStats.recomputeForAgent, {
        agentId: agent._id,
      });
    }

    await ctx.scheduler.runAfter(0, internal.agentStats.recomputeAllTiers, {});

    return {
      queuedAgents: agents.length,
      queuedTierRecompute: true,
    };
  },
});

function enrichStatsForResponse(stats: any) {
  return {
    ...stats,
    scoreBreakdown: stats?.scoreBreakdownJson ? safeParseJson(stats.scoreBreakdownJson) : null,
    riskFlags: parseRiskFlags(stats?.riskFlagsJson),
  };
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function buildLeaderboardPayload(ctx: any, stats: any[]) {
  return await Promise.all(
    stats.map(async (s) => {
      const user = await ctx.db.get(s.agentId);
      return {
        ...enrichStatsForResponse(s),
        agent: user
          ? {
              _id: user._id,
              name: user.name,
              avatarUrl: user.avatarUrl,
              githubUsername: user.githubUsername,
            }
          : null,
      };
    }),
  );
}

export const getByAgent = query({
  args: { agentId: v.id("users") },
  handler: async (ctx, args) => {
    requireAuth(await getCurrentUser(ctx));

    const stats = await ctx.db
      .query("agentStats")
      .withIndex("by_agentId", (q) => q.eq("agentId", args.agentId))
      .unique();

    return stats ? enrichStatsForResponse(stats) : null;
  },
});

export const getByAgentInternal = internalQuery({
  args: { agentId: v.id("users") },
  handler: async (ctx, args) => {
    const stats = await ctx.db
      .query("agentStats")
      .withIndex("by_agentId", (q) => q.eq("agentId", args.agentId))
      .unique();

    return stats ? enrichStatsForResponse(stats) : null;
  },
});

export const getLeaderboard = query({
  args: {
    limit: v.optional(v.number()),
    rankedOnly: v.optional(v.boolean()),
    includeUnranked: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const user = requireAuth(await getCurrentUser(ctx));

    const limit = args.limit ?? 50;
    const rankedOnly = args.rankedOnly ?? true;
    const includeUnranked = user.role === "admin" ? (args.includeUnranked ?? false) : false;

    const scanLimit = Math.min(Math.max(limit * 5, 50), 500);
    let stats = await ctx.db
      .query("agentStats")
      .withIndex("by_compositeScore")
      .order("desc")
      .take(scanLimit);

    if (rankedOnly || !includeUnranked) {
      stats = stats.filter((s) => s.tier !== "unranked");
    }

    return await buildLeaderboardPayload(ctx, stats.slice(0, limit));
  },
});

export const getLeaderboardInternal = internalQuery({
  args: {
    limit: v.optional(v.number()),
    rankedOnly: v.optional(v.boolean()),
    includeUnranked: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 50;
    const rankedOnly = args.rankedOnly ?? true;
    const includeUnranked = args.includeUnranked ?? false;

    const scanLimit = Math.min(Math.max(limit * 5, 50), 500);
    let stats = await ctx.db
      .query("agentStats")
      .withIndex("by_compositeScore")
      .order("desc")
      .take(scanLimit);

    if (rankedOnly || !includeUnranked) {
      stats = stats.filter((s) => s.tier !== "unranked");
    }

    return await buildLeaderboardPayload(ctx, stats.slice(0, limit));
  },
});
