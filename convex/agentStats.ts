import { query, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { getCurrentUser, requireAuth } from "./lib/utils";
import { internal } from "./_generated/api";
import {
  timeDecayWeight,
  rewardWeight,
  MIN_COMPLETED_BOUNTIES,
  MIN_UNIQUE_RATERS,
  CONCENTRATION_CAP_THRESHOLD,
  assignTierFromTrustScore,
  computeTrustScore,
  getConfidenceLevel,
} from "./lib/tierCalculation";

function getWeightedAverage(sum: number, weight: number): number {
  return weight > 0 ? sum / weight : 0;
}

function withAgentStatDefaults(stats: any) {
  if (!stats) return null;

  return {
    ...stats,
    avgMergeReadinessRating: stats.avgMergeReadinessRating ?? stats.avgCreatorRating ?? 0,
    avgCodeQualityRating: stats.avgCodeQualityRating ?? 0,
    avgTestCoverageRating: stats.avgTestCoverageRating ?? 0,
    avgCommunicationRating: stats.avgCommunicationRating ?? 0,
    avgSpeedRating: stats.avgSpeedRating ?? 0,
    eligibleUniqueRaters:
      stats.eligibleUniqueRaters ?? stats.trustedUniqueRaters ?? stats.uniqueRaters ?? 0,
    eligibleRatingsCount: stats.eligibleRatingsCount ?? 0,
    verificationReliabilityRate:
      stats.verificationReliabilityRate ?? stats.firstAttemptPassRate ?? 0,
    claimReliabilityRate: stats.claimReliabilityRate ?? stats.completionRate ?? 0,
    trustScore: stats.trustScore ?? stats.finalScore ?? stats.compositeScore ?? 0,
    confidenceLevel: stats.confidenceLevel ?? "low",
  };
}

function calculateTierForStats(stats: any) {
  const normalizedStats = withAgentStatDefaults(stats);
  if (!normalizedStats) {
    return "unranked" as const;
  }

  let tier = assignTierFromTrustScore({
    totalBountiesCompleted: normalizedStats.totalBountiesCompleted,
    eligibleUniqueRaters: normalizedStats.eligibleUniqueRaters,
    trustScore: normalizedStats.trustScore,
    avgMergeReadinessRating: normalizedStats.avgMergeReadinessRating,
    claimReliabilityRate: normalizedStats.claimReliabilityRate,
    verificationReliabilityRate: normalizedStats.verificationReliabilityRate,
    confidenceLevel: normalizedStats.confidenceLevel,
  });

  if (
    normalizedStats.singleCreatorConcentration > CONCENTRATION_CAP_THRESHOLD &&
    (tier === "S" || tier === "A")
  ) {
    tier = "B";
  }

  return tier;
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

    const allClaims: any[] = await ctx.db
      .query("bountyClaims")
      .withIndex("by_agentId", (q) => q.eq("agentId", args.agentId))
      .collect();

    const completedClaims = allClaims.filter((c) => c.status === "completed");
    const expiredClaims = allClaims.filter((c) => c.status === "expired");
    const releasedClaims = allClaims.filter((c) => c.status === "released");
    const terminalClaims = allClaims.filter(
      (c) => c.status === "completed" || c.status === "expired" || c.status === "released",
    );

    const totalBountiesClaimed = allClaims.length;
    const totalBountiesCompleted = completedClaims.length;
    const totalBountiesExpired = expiredClaims.length;

    const claimDenominator =
      totalBountiesCompleted + expiredClaims.length + releasedClaims.length;
    const claimReliabilityRate =
      claimDenominator > 0 ? totalBountiesCompleted / claimDenominator : 0;
    const completionRate = claimReliabilityRate;

    let totalSubmissions = 0;
    let totalFirstAttemptPasses = 0;
    let totalTerminalClaimsWithSubmissions = 0;
    let totalGatePasses = 0;
    let totalGateWarnings = 0;
    let weightedTimeSum = 0;
    let weightedTimeWeightSum = 0;
    let submissionsPerBountySum = 0;

    for (const claim of terminalClaims) {
      const ageMs = now - claim.claimedAt;
      const decay = timeDecayWeight(ageMs);

      const bountySubmissions: any[] = await ctx.db
        .query("submissions")
        .withIndex("by_bountyId", (q) => q.eq("bountyId", claim.bountyId))
        .filter((q) => q.eq(q.field("agentId"), args.agentId))
        .collect();

      totalSubmissions += bountySubmissions.length;

      if (claim.status === "completed") {
        submissionsPerBountySum += bountySubmissions.length;
      }

      if (bountySubmissions.length === 0) {
        continue;
      }

      totalTerminalClaimsWithSubmissions++;

      const sortedSubmissions = bountySubmissions.sort(
        (a, b) => a._creationTime - b._creationTime,
      );

      const firstSubmission = sortedSubmissions[0];
      const firstVerification = await ctx.db
        .query("verifications")
        .withIndex("by_submissionId", (q) => q.eq("submissionId", firstSubmission._id))
        .first();

      if (firstVerification?.status === "passed") {
        totalFirstAttemptPasses++;
      }

      const passingSubmission = sortedSubmissions.find((submission) => submission.status === "passed");
      if (!passingSubmission) {
        continue;
      }

      const passedVerification = await ctx.db
        .query("verifications")
        .withIndex("by_submissionId", (q) => q.eq("submissionId", passingSubmission._id))
        .first();

      if (!passedVerification?.completedAt) {
        continue;
      }

      const resolutionMs = passedVerification.completedAt - claim.claimedAt;
      weightedTimeSum += resolutionMs * decay;
      weightedTimeWeightSum += decay;

      const gates: any[] = await ctx.db
        .query("sanityGates")
        .withIndex("by_verificationId", (q) => q.eq("verificationId", passedVerification._id))
        .collect();

      for (const gate of gates) {
        if (gate.status === "passed") totalGatePasses++;
        if (gate.status === "warning") totalGateWarnings++;
      }
    }

    const avgTimeToResolutionMs = getWeightedAverage(weightedTimeSum, weightedTimeWeightSum);
    const avgSubmissionsPerBounty =
      totalBountiesCompleted > 0 ? submissionsPerBountySum / totalBountiesCompleted : 0;
    const verificationReliabilityRate =
      totalTerminalClaimsWithSubmissions > 0
        ? totalFirstAttemptPasses / totalTerminalClaimsWithSubmissions
        : 0;
    const firstAttemptPassRate = verificationReliabilityRate;

    const totalGates = totalGatePasses + totalGateWarnings;
    const gateQualityScore = totalGates > 0 ? totalGatePasses / totalGates : 0;

    const allRatings: any[] = await ctx.db
      .query("agentRatings")
      .withIndex("by_agentId", (q) => q.eq("agentId", args.agentId))
      .collect();
    const eligibleRatings = allRatings.filter((r) => r.tierEligible);

    let avgCreatorRating = 0;
    let avgMergeReadinessRating = 0;
    let avgCodeQualityRating = 0;
    let avgTestCoverageRating = 0;
    let avgCommunicationRating = 0;
    let avgSpeedRating = 0;
    const totalRatings = allRatings.length;

    const rawCreatorCounts = new Map<string, number>();
    const eligibleCreatorCounts = new Map<string, number>();

    for (const rating of allRatings) {
      rawCreatorCounts.set(rating.creatorId, (rawCreatorCounts.get(rating.creatorId) ?? 0) + 1);
    }

    if (eligibleRatings.length > 0) {
      let ratingWeightSum = 0;
      let creatorRatingSum = 0;
      let mergeReadinessSum = 0;
      let codeQualitySum = 0;
      let testCoverageSum = 0;
      let communicationSum = 0;
      let speedSum = 0;

      for (const rating of eligibleRatings) {
        const bounty = (await ctx.db.get(rating.bountyId)) as any;
        if (!bounty) continue;

        const ageMs = now - rating.createdAt;
        const decay = timeDecayWeight(ageMs);
        const weight = rewardWeight(bounty.reward) * decay;
        const creatorAverage =
          (rating.codeQuality +
            rating.speed +
            rating.mergedWithoutChanges +
            rating.communication +
            rating.testCoverage) /
          5;

        ratingWeightSum += weight;
        creatorRatingSum += creatorAverage * weight;
        mergeReadinessSum += rating.mergedWithoutChanges * weight;
        codeQualitySum += rating.codeQuality * weight;
        testCoverageSum += rating.testCoverage * weight;
        communicationSum += rating.communication * weight;
        speedSum += rating.speed * weight;

        eligibleCreatorCounts.set(
          rating.creatorId,
          (eligibleCreatorCounts.get(rating.creatorId) ?? 0) + 1,
        );
      }

      avgCreatorRating = getWeightedAverage(creatorRatingSum, ratingWeightSum);
      avgMergeReadinessRating = getWeightedAverage(mergeReadinessSum, ratingWeightSum);
      avgCodeQualityRating = getWeightedAverage(codeQualitySum, ratingWeightSum);
      avgTestCoverageRating = getWeightedAverage(testCoverageSum, ratingWeightSum);
      avgCommunicationRating = getWeightedAverage(communicationSum, ratingWeightSum);
      avgSpeedRating = getWeightedAverage(speedSum, ratingWeightSum);
    }

    const uniqueRaters = rawCreatorCounts.size;
    const eligibleUniqueRaters = eligibleCreatorCounts.size;
    const eligibleRatingsCount = eligibleRatings.length;
    const eligibleCreatorCountsArray = Array.from(eligibleCreatorCounts.values()) as number[];
    const maxEligibleFromOneCreator =
      eligibleCreatorCountsArray.length > 0 ? Math.max(...eligibleCreatorCountsArray) : 0;
    const singleCreatorConcentration =
      eligibleRatingsCount > 0 ? maxEligibleFromOneCreator / eligibleRatingsCount : 0;

    const trustScore = computeTrustScore({
      avgMergeReadinessRating,
      verificationReliabilityRate,
      claimReliabilityRate,
      avgCodeQualityRating,
      avgTestCoverageRating,
      avgTimeToResolutionMs,
    });
    const confidenceLevel = getConfidenceLevel(totalBountiesCompleted, eligibleUniqueRaters);

    const existing: any = await ctx.db
      .query("agentStats")
      .withIndex("by_agentId", (q) => q.eq("agentId", args.agentId))
      .unique();

    const statsData = {
      agentId: args.agentId,
      totalBountiesCompleted,
      totalBountiesClaimed,
      totalBountiesExpired,
      totalSubmissions,
      totalFirstAttemptPasses,
      totalGateWarnings,
      totalGatePasses,
      avgTimeToResolutionMs,
      avgSubmissionsPerBounty,
      firstAttemptPassRate,
      completionRate,
      gateQualityScore,
      avgCreatorRating,
      avgMergeReadinessRating,
      avgCodeQualityRating,
      avgTestCoverageRating,
      avgCommunicationRating,
      avgSpeedRating,
      totalRatings,
      uniqueRaters,
      eligibleUniqueRaters,
      eligibleRatingsCount,
      singleCreatorConcentration,
      verificationReliabilityRate,
      claimReliabilityRate,
      trustScore,
      confidenceLevel,
      compositeScore: trustScore,
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

export const recomputeAllAgentStats = internalMutation({
  args: {},
  handler: async (ctx) => {
    const agents: any[] = await ctx.db
      .query("users")
      .withIndex("by_role", (q) => q.eq("role", "agent"))
      .collect();

    for (const agent of agents) {
      await ctx.scheduler.runAfter(0, internal.agentStats.recomputeForAgent, {
        agentId: agent._id,
      });
    }
  },
});

/**
 * Recompute all tiers based on absolute trust thresholds.
 * Called by daily cron.
 */
export const recomputeAllTiers = internalMutation({
  args: {},
  handler: async (ctx) => {
    const allStats: any[] = await ctx.db.query("agentStats").collect();

    for (const stats of allStats) {
      const normalizedStats = withAgentStatDefaults(stats);
      const tier = calculateTierForStats(normalizedStats);
      await ctx.db.patch(stats._id, {
        tier,
        compositeScore: normalizedStats.trustScore,
      });
    }
  },
});

export const recomputeTierForAgent = internalMutation({
  args: { agentId: v.id("users") },
  handler: async (ctx, args) => {
    const stats = await ctx.db
      .query("agentStats")
      .withIndex("by_agentId", (q) => q.eq("agentId", args.agentId))
      .unique();

    if (!stats) {
      return "unranked" as const;
    }

    const normalizedStats = withAgentStatDefaults(stats);
    const tier = calculateTierForStats(normalizedStats);

    await ctx.db.patch(stats._id, {
      tier,
      compositeScore: normalizedStats.trustScore,
    });

    return tier;
  },
});

export const getByAgent = query({
  args: { agentId: v.id("users") },
  handler: async (ctx, args) => {
    requireAuth(await getCurrentUser(ctx));

    return withAgentStatDefaults(await ctx.db
      .query("agentStats")
      .withIndex("by_agentId", (q) => q.eq("agentId", args.agentId))
      .unique());
  },
});

export const getByAgentInternal = internalQuery({
  args: { agentId: v.id("users") },
  handler: async (ctx, args) => {
    return withAgentStatDefaults(await ctx.db
      .query("agentStats")
      .withIndex("by_agentId", (q) => q.eq("agentId", args.agentId))
      .unique());
  },
});

function sortLeaderboardEntries<
  T extends {
    agentId: string;
    trustScore: number;
    avgMergeReadinessRating: number;
    totalBountiesCompleted: number;
    eligibleUniqueRaters: number;
  },
>(stats: T[]): T[] {
  return stats.sort((a, b) => {
    if (b.trustScore !== a.trustScore) return b.trustScore - a.trustScore;
    if (b.avgMergeReadinessRating !== a.avgMergeReadinessRating) {
      return b.avgMergeReadinessRating - a.avgMergeReadinessRating;
    }
    if (b.totalBountiesCompleted !== a.totalBountiesCompleted) {
      return b.totalBountiesCompleted - a.totalBountiesCompleted;
    }
    return b.eligibleUniqueRaters - a.eligibleUniqueRaters;
  });
}

export const getLeaderboard = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    requireAuth(await getCurrentUser(ctx));

    const limit = args.limit ?? 50;
    const rankedStats = sortLeaderboardEntries(
      ((await ctx.db.query("agentStats").collect()) as any[])
        .map(withAgentStatDefaults)
        .filter((stats) => stats.tier !== "unranked"),
    ).slice(0, limit);

    return await Promise.all(
      rankedStats.map(async (stats) => {
        const user = (await ctx.db.get(stats.agentId)) as any;
        return {
          ...stats,
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
  },
});

export const getLeaderboardInternal = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 50;
    const rankedStats = sortLeaderboardEntries(
      ((await ctx.db.query("agentStats").collect()) as any[])
        .map(withAgentStatDefaults)
        .filter((stats) => stats.tier !== "unranked"),
    ).slice(0, limit);

    return await Promise.all(
      rankedStats.map(async (stats) => {
        const user = (await ctx.db.get(stats.agentId)) as any;
        return {
          ...stats,
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
  },
});
