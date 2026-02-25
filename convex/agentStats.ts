import { query, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { getCurrentUser, requireAuth } from "./lib/utils";
import {
  timeDecayWeight,
  rewardWeight,
  SCORE_WEIGHTS,
  MIN_COMPLETED_BOUNTIES,
  MIN_UNIQUE_RATERS,
  CONCENTRATION_CAP_THRESHOLD,
  assignTierByPercentile,
} from "./lib/tierCalculation";

/**
 * Recompute all metrics for a single agent.
 * Called after bounty completion or rating submission.
 * Tier is NOT set here — only by the daily cron.
 */
export const recomputeForAgent = internalMutation({
  args: { agentId: v.id("users") },
  handler: async (ctx, args) => {
    const now = Date.now();

    // 1. Fetch all claims for this agent
    const allClaims = await ctx.db
      .query("bountyClaims")
      .withIndex("by_agentId", (q) => q.eq("agentId", args.agentId))
      .collect();

    const completedClaims = allClaims.filter((c) => c.status === "completed");
    const expiredClaims = allClaims.filter((c) => c.status === "expired");
    const releasedClaims = allClaims.filter((c) => c.status === "released");

    const totalBountiesClaimed = allClaims.length;
    const totalBountiesCompleted = completedClaims.length;
    const totalBountiesExpired = expiredClaims.length;

    // Completion rate
    const denominator = totalBountiesCompleted + expiredClaims.length + releasedClaims.length;
    const completionRate = denominator > 0 ? totalBountiesCompleted / denominator : 0;

    // 2. Per-bounty metrics with time decay
    let totalSubmissions = 0;
    let totalFirstAttemptPasses = 0;
    let totalGatePasses = 0;
    let totalGateWarnings = 0;

    // For weighted averages
    let weightedTimeSum = 0;
    let weightedTimeWeightSum = 0;
    let weightedSpeedRatioSum = 0;
    let weightedSpeedWeightSum = 0;
    let submissionsPerBountySum = 0;

    for (const claim of completedClaims) {
      const bounty = await ctx.db.get(claim.bountyId);
      if (!bounty) continue;

      const ageMs = now - claim.claimedAt;
      const decay = timeDecayWeight(ageMs);

      // Time to resolution
      const allVerifications = await ctx.db
        .query("verifications")
        .withIndex("by_bountyId", (q) => q.eq("bountyId", claim.bountyId))
        .collect();

      const passedVerification = allVerifications.find((v) => v.status === "passed");
      if (passedVerification?.completedAt) {
        const resolutionMs = passedVerification.completedAt - claim.claimedAt;
        weightedTimeSum += resolutionMs * decay;
        weightedTimeWeightSum += decay;

        // Speed ratio relative to claim duration
        const claimDurationMs = (bounty.claimDurationHours ?? 4) * 60 * 60 * 1000;
        const speedRatio = Math.max(0, Math.min(1, 1 - resolutionMs / claimDurationMs));
        weightedSpeedRatioSum += speedRatio * decay;
        weightedSpeedWeightSum += decay;
      }

      // Submissions for this bounty
      const bountySubmissions = await ctx.db
        .query("submissions")
        .withIndex("by_bountyId", (q) => q.eq("bountyId", claim.bountyId))
        .filter((q) => q.eq(q.field("agentId"), args.agentId))
        .collect();

      totalSubmissions += bountySubmissions.length;
      submissionsPerBountySum += bountySubmissions.length;

      // First attempt pass check
      if (bountySubmissions.length > 0) {
        // Sort by creation time to find first submission
        const sorted = bountySubmissions.sort((a, b) => a._creationTime - b._creationTime);
        const firstSub = sorted[0];
        const firstVerification = await ctx.db
          .query("verifications")
          .withIndex("by_submissionId", (q) => q.eq("submissionId", firstSub._id))
          .first();
        if (firstVerification?.status === "passed") {
          totalFirstAttemptPasses++;
        }
      }

      // Gate quality metrics from passing verifications
      for (const ver of allVerifications.filter((v) => v.status === "passed")) {
        const gates = await ctx.db
          .query("sanityGates")
          .withIndex("by_verificationId", (q) => q.eq("verificationId", ver._id))
          .collect();
        for (const gate of gates) {
          if (gate.status === "passed") totalGatePasses++;
          if (gate.status === "warning") totalGateWarnings++;
        }
      }
    }

    // Aggregate metrics
    const avgTimeToResolutionMs =
      weightedTimeWeightSum > 0 ? weightedTimeSum / weightedTimeWeightSum : 0;
    const avgSubmissionsPerBounty =
      totalBountiesCompleted > 0 ? submissionsPerBountySum / totalBountiesCompleted : 0;
    const firstAttemptPassRate =
      totalBountiesCompleted > 0 ? totalFirstAttemptPasses / totalBountiesCompleted : 0;

    const totalGates = totalGatePasses + totalGateWarnings;
    const gateQualityScore = totalGates > 0 ? totalGatePasses / totalGates : 0;

    // 3. Rating aggregates (tier-eligible only)
    const allRatings = await ctx.db
      .query("agentRatings")
      .withIndex("by_agentId", (q) => q.eq("agentId", args.agentId))
      .collect();

    const eligibleRatings = allRatings.filter((r) => r.tierEligible);

    let avgCreatorRating = 0;
    const totalRatings = allRatings.length;
    const creatorCounts = new Map<string, number>();

    if (eligibleRatings.length > 0) {
      let weightedRatingSum = 0;
      let ratingWeightSum = 0;

      for (const r of eligibleRatings) {
        const bounty = await ctx.db.get(r.bountyId);
        if (!bounty) continue;

        const dimAvg =
          (r.codeQuality + r.speed + r.mergedWithoutChanges + r.communication + r.testCoverage) / 5;
        const ageMs = now - r.createdAt;
        const decay = timeDecayWeight(ageMs);
        const rw = rewardWeight(bounty.reward);
        const weight = rw * decay;

        weightedRatingSum += dimAvg * weight;
        ratingWeightSum += weight;

        creatorCounts.set(r.creatorId, (creatorCounts.get(r.creatorId) ?? 0) + 1);
      }

      avgCreatorRating = ratingWeightSum > 0 ? weightedRatingSum / ratingWeightSum : 0;
    }

    // Also count creators from non-eligible ratings for uniqueRaters
    for (const r of allRatings) {
      if (!creatorCounts.has(r.creatorId)) {
        creatorCounts.set(r.creatorId, (creatorCounts.get(r.creatorId) ?? 0) + 1);
      }
    }

    const uniqueRaters = creatorCounts.size;
    const maxFromOneCreator = Math.max(0, ...Array.from(creatorCounts.values()));
    const singleCreatorConcentration = totalRatings > 0 ? maxFromOneCreator / totalRatings : 0;

    // 4. Composite score
    const creatorRatingScore =
      eligibleRatings.length > 0 ? (avgCreatorRating / 5.0) * 100 : 50; // neutral if no ratings
    const timeToResolutionScore =
      weightedSpeedWeightSum > 0
        ? (weightedSpeedRatioSum / weightedSpeedWeightSum) * 100
        : 50;
    const firstAttemptPassScore = firstAttemptPassRate * 100;
    const gateQualityScoreNormalized = gateQualityScore * 100;
    const completionRateScore = completionRate * 100;

    const compositeScore =
      creatorRatingScore * SCORE_WEIGHTS.creatorRating +
      timeToResolutionScore * SCORE_WEIGHTS.timeToResolution +
      firstAttemptPassScore * SCORE_WEIGHTS.firstAttemptPass +
      gateQualityScoreNormalized * SCORE_WEIGHTS.gateQuality +
      completionRateScore * SCORE_WEIGHTS.completionRate;

    // 5. Upsert agentStats
    const existing = await ctx.db
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
      totalRatings,
      uniqueRaters,
      singleCreatorConcentration,
      compositeScore,
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

/**
 * Recompute all tiers based on relative percentile ranking.
 * Called by daily cron.
 */
export const recomputeAllTiers = internalMutation({
  args: {},
  handler: async (ctx) => {
    // Fetch all agentStats
    const allStats = await ctx.db.query("agentStats").collect();

    // Filter to qualified agents
    const qualified = allStats.filter(
      (s) =>
        s.totalBountiesCompleted >= MIN_COMPLETED_BOUNTIES &&
        s.uniqueRaters >= MIN_UNIQUE_RATERS
    );

    // Sort by compositeScore descending, ties broken by totalBountiesCompleted
    qualified.sort((a, b) => {
      if (b.compositeScore !== a.compositeScore) {
        return b.compositeScore - a.compositeScore;
      }
      return b.totalBountiesCompleted - a.totalBountiesCompleted;
    });

    // Assign tiers
    for (let i = 0; i < qualified.length; i++) {
      let tier = assignTierByPercentile(i, qualified.length);

      // Concentration cap: agents with > 60% ratings from one creator capped at B
      if (
        qualified[i].singleCreatorConcentration > CONCENTRATION_CAP_THRESHOLD &&
        (tier === "S" || tier === "A")
      ) {
        tier = "B";
      }

      await ctx.db.patch(qualified[i]._id, { tier });
    }

    // Unqualified agents stay unranked
    const unqualified = allStats.filter(
      (s) =>
        s.totalBountiesCompleted < MIN_COMPLETED_BOUNTIES ||
        s.uniqueRaters < MIN_UNIQUE_RATERS
    );

    for (const s of unqualified) {
      if (s.tier !== "unranked") {
        await ctx.db.patch(s._id, { tier: "unranked" });
      }
    }
  },
});

export const getByAgent = query({
  args: { agentId: v.id("users") },
  handler: async (ctx, args) => {
    requireAuth(await getCurrentUser(ctx));

    return await ctx.db
      .query("agentStats")
      .withIndex("by_agentId", (q) => q.eq("agentId", args.agentId))
      .unique();
  },
});

export const getByAgentInternal = internalQuery({
  args: { agentId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("agentStats")
      .withIndex("by_agentId", (q) => q.eq("agentId", args.agentId))
      .unique();
  },
});

export const getLeaderboard = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    requireAuth(await getCurrentUser(ctx));

    const limit = args.limit ?? 50;

    const stats = await ctx.db
      .query("agentStats")
      .withIndex("by_compositeScore")
      .order("desc")
      .take(limit);

    // Enrich with user info
    return await Promise.all(
      stats.map(async (s) => {
        const user = await ctx.db.get(s.agentId);
        return {
          ...s,
          agent: user
            ? {
                _id: user._id,
                name: user.name,
                avatarUrl: user.avatarUrl,
                githubUsername: user.githubUsername,
              }
            : null,
        };
      })
    );
  },
});

export const getLeaderboardInternal = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 50;

    const stats = await ctx.db
      .query("agentStats")
      .withIndex("by_compositeScore")
      .order("desc")
      .take(limit);

    return await Promise.all(
      stats.map(async (s) => {
        const user = await ctx.db.get(s.agentId);
        return {
          ...s,
          agent: user
            ? {
                _id: user._id,
                name: user.name,
                avatarUrl: user.avatarUrl,
                githubUsername: user.githubUsername,
              }
            : null,
        };
      })
    );
  },
});
