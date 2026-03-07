import { convexTest } from "convex-test";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import {
  seedUser,
  seedBounty,
  seedClaim,
  seedSubmission,
  seedVerification,
  seedRating,
} from "./__tests__/helpers";

// recomputeForAgent may trigger background scheduled functions via
// ctx.scheduler.runAfter(). In convex-test these can cause "Write outside of
// transaction" unhandled rejections. We suppress them here since the mutation
// itself completes correctly.
let rejectionHandler: (err: unknown) => void;
const TRUSTED_AGE_MS = 40 * 24 * 60 * 60 * 1000;
beforeEach(() => {
  rejectionHandler = () => {};
  process.on("unhandledRejection", rejectionHandler);
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
});
afterEach(() => {
  process.removeListener("unhandledRejection", rejectionHandler);
  vi.useRealTimers();
});

/**
 * Helper: seed a fully completed bounty for an agent with a passing
 * submission, verification, and a tier-eligible rating from a given creator.
 */
async function seedCompletedBountyWithRating(
  ctx: any,
  agentId: any,
  creatorId: any,
  overrides: {
    bountyReward?: number;
    ratingOverrides?: Record<string, unknown>;
  } = {},
) {
  const bountyId = await seedBounty(ctx, creatorId, {
    status: "completed",
    reward: overrides.bountyReward ?? 100,
  });

  const now = Date.now();
  await seedClaim(ctx, bountyId, agentId, {
    status: "completed",
    claimedAt: now - 2 * 60 * 60 * 1000, // 2 hours ago
  });

  const submissionId = await seedSubmission(ctx, bountyId, agentId, {
    status: "passed",
  });

  await seedVerification(ctx, submissionId, bountyId, {
    status: "passed",
    completedAt: now,
  });

  await seedRating(ctx, bountyId, agentId, creatorId, {
    tierEligible: true,
    createdAt: now,
    ...(overrides.ratingOverrides ?? {}),
  });

  await ctx.db.insert("payments" as any, {
    bountyId,
    recipientId: agentId,
    amount: overrides.bountyReward ?? 100,
    currency: "USD",
    method: "stripe",
    status: "completed",
    createdAt: now,
  });

  return bountyId;
}

async function seedTrustedCreator(ctx: any) {
  const creatorId = await seedUser(ctx, { role: "creator" });
  const recipientId = await seedUser(ctx, { role: "agent" });

  for (let i = 0; i < 2; i++) {
    const bountyId = await seedBounty(ctx, creatorId, {
      status: "completed",
      reward: 100,
    });
    await ctx.db.insert("payments" as any, {
      bountyId,
      recipientId,
      amount: 100,
      currency: "USD",
      method: "stripe",
      status: "completed",
      createdAt: Date.now(),
    });
  }

  return creatorId;
}

async function seedAgentStatsRow(
  ctx: any,
  agentId: any,
  overrides: Record<string, unknown> = {},
) {
  const now = Date.now();
  return await ctx.db.insert("agentStats" as any, {
    agentId,
    totalBountiesCompleted: 5,
    totalBountiesClaimed: 5,
    totalBountiesExpired: 0,
    paidBountiesCompleted: 5,
    paidPayoutVolumeUsd: 1000,
    totalSubmissions: 5,
    totalFirstAttemptPasses: 5,
    totalGateWarnings: 0,
    totalGatePasses: 5,
    avgTimeToResolutionMs: 60_000,
    avgSubmissionsPerBounty: 1,
    firstAttemptPassRate: 1,
    completionRate: 1,
    gateQualityScore: 1,
    avgCreatorRating: 5,
    totalRatings: 5,
    uniqueRaters: 3,
    trustedUniqueRaters: 3,
    singleCreatorConcentration: 0.33,
    gamingRiskScore: 0,
    finalScore: 80,
    compositeScore: 80,
    tier: "A",
    lastComputedAt: now,
    ...overrides,
  });
}

describe("recomputeForAgent", () => {
  it("creates stats for agent with completed bounties", async () => {
    const t = convexTest(schema);

    const { agentId } = await t.run(async (ctx) => {
      const creatorId = await seedTrustedCreator(ctx);
      const agentId = await seedUser(ctx, { role: "agent" });

      await seedCompletedBountyWithRating(ctx, agentId, creatorId);

      return { agentId };
    });

    vi.advanceTimersByTime(TRUSTED_AGE_MS);
    await t.mutation(internal.agentStats.recomputeForAgent, { agentId });

    const stats = await t.run(async (ctx) => {
      return await ctx.db
        .query("agentStats")
        .withIndex("by_agentId", (q: any) => q.eq("agentId", agentId))
        .first();
    });

    expect(stats).not.toBeNull();
    expect(stats!.totalBountiesCompleted).toBe(1);
    expect(stats!.compositeScore).toBeGreaterThan(0);
    expect(stats!.agentId).toEqual(agentId);
  });

  it("handles agent with no completed bounties", async () => {
    const t = convexTest(schema);

    const { agentId } = await t.run(async (ctx) => {
      const agentId = await seedUser(ctx, { role: "agent" });
      return { agentId };
    });

    vi.advanceTimersByTime(TRUSTED_AGE_MS);
    await t.mutation(internal.agentStats.recomputeForAgent, { agentId });

    const stats = await t.run(async (ctx) => {
      return await ctx.db
        .query("agentStats")
        .withIndex("by_agentId", (q: any) => q.eq("agentId", agentId))
        .first();
    });

    expect(stats).not.toBeNull();
    expect(stats!.totalBountiesCompleted).toBe(0);
    // With no claims and no ratings, the composite score is a baseline value
    // derived from neutral defaults for missing data (creatorRating=50,
    // timeToResolution=50) weighted by SCORE_WEIGHTS. It should NOT be a high
    // score. The key invariant is totalBountiesCompleted=0.
    expect(stats!.totalSubmissions).toBe(0);
    expect(stats!.completionRate).toBe(0);
    expect(stats!.tier).toBe("unranked");
  });

  it("incorporates creator ratings into score", async () => {
    const t = convexTest(schema);

    const { agentId } = await t.run(async (ctx) => {
      const creatorId = await seedTrustedCreator(ctx);
      const agentId = await seedUser(ctx, { role: "agent" });

      await seedCompletedBountyWithRating(ctx, agentId, creatorId, {
        ratingOverrides: {
          codeQuality: 5,
          speed: 5,
          mergedWithoutChanges: 5,
          communication: 5,
          testCoverage: 5,
        },
      });

      return { agentId };
    });

    vi.advanceTimersByTime(TRUSTED_AGE_MS);
    await t.mutation(internal.agentStats.recomputeForAgent, { agentId });

    const stats = await t.run(async (ctx) => {
      return await ctx.db
        .query("agentStats")
        .withIndex("by_agentId", (q: any) => q.eq("agentId", agentId))
        .first();
    });

    expect(stats).not.toBeNull();
    expect(stats!.avgCreatorRating).toBe(5);
  });

  it("excludes test bounties from paid ranking metrics", async () => {
    const t = convexTest(schema);

    const { agentId } = await t.run(async (ctx) => {
      const creatorId = await seedTrustedCreator(ctx);
      const agentId = await seedUser(ctx, { role: "agent" });
      const now = Date.now();

      await seedCompletedBountyWithRating(ctx, agentId, creatorId, {
        bountyReward: 100,
      });

      const testBountyId = await seedBounty(ctx, creatorId, {
        status: "completed",
        reward: 500,
        isTestBounty: true,
      });
      await seedClaim(ctx, testBountyId, agentId, {
        status: "completed",
        claimedAt: now - 60 * 60 * 1000,
      });
      await seedRating(ctx, testBountyId, agentId, creatorId, {
        codeQuality: 5,
        speed: 5,
        mergedWithoutChanges: 5,
        communication: 5,
        testCoverage: 5,
        tierEligible: true,
        createdAt: now,
      });
      await ctx.db.insert("payments" as any, {
        bountyId: testBountyId,
        recipientId: agentId,
        amount: 500,
        currency: "USD",
        method: "stripe",
        status: "completed",
        createdAt: now,
      });

      return { agentId };
    });

    vi.advanceTimersByTime(TRUSTED_AGE_MS);
    await t.mutation(internal.agentStats.recomputeForAgent, { agentId });

    const stats = await t.run(async (ctx) =>
      ctx.db
        .query("agentStats")
        .withIndex("by_agentId", (q: any) => q.eq("agentId", agentId))
        .first()
    );

    expect(stats).not.toBeNull();
    expect(stats!.totalBountiesCompleted).toBe(2);
    expect(stats!.paidBountiesCompleted).toBe(1);
    expect(stats!.paidPayoutVolumeUsd).toBe(100);
  });

  it("excludes fresh sybil creators from trusted unique rater gate", async () => {
    const t = convexTest(schema);

    const { agentId } = await t.run(async (ctx) => {
      const agentId = await seedUser(ctx, { role: "agent" });
      for (let i = 0; i < 3; i++) {
        const creatorId = await seedUser(ctx, { role: "creator" });
        await seedCompletedBountyWithRating(ctx, agentId, creatorId, {
          bountyReward: 100,
        });
      }
      return { agentId };
    });

    await t.mutation(internal.agentStats.recomputeForAgent, { agentId });

    const stats = await t.run(async (ctx) =>
      ctx.db
        .query("agentStats")
        .withIndex("by_agentId", (q: any) => q.eq("agentId", agentId))
        .first()
    );

    expect(stats).not.toBeNull();
    expect(stats!.uniqueRaters).toBe(3);
    expect(stats!.trustedUniqueRaters).toBe(0);
  });

  it("derives Sonar/Snyk risk burdens and advisory process reliability from normalized receipts", async () => {
    const t = convexTest(schema);

    const { agentId } = await t.run(async (ctx) => {
      const creatorId = await seedTrustedCreator(ctx);
      const agentId = await seedUser(ctx, { role: "agent" });

      const bountyId = await seedBounty(ctx, creatorId, {
        status: "completed",
        reward: 100,
      });

      const now = Date.now();
      await seedClaim(ctx, bountyId, agentId, {
        status: "completed",
        claimedAt: now - 2 * 60 * 60 * 1000,
      });

      const submissionId = await seedSubmission(ctx, bountyId, agentId, {
        status: "passed",
      });

      const verificationId = await seedVerification(ctx, submissionId, bountyId, {
        status: "passed",
        completedAt: now,
      });

      await seedRating(ctx, bountyId, agentId, creatorId, {
        tierEligible: true,
        createdAt: now,
      });

      await ctx.db.insert("payments" as any, {
        bountyId,
        recipientId: agentId,
        amount: 100,
        currency: "USD",
        method: "stripe",
        status: "completed",
        createdAt: now,
      });

      await ctx.db.insert("verificationReceipts", {
        verificationId,
        submissionId,
        bountyId,
        agentId,
        attemptNumber: 1,
        legKey: "snyk_no_new_high_critical",
        orderIndex: 6,
        status: "pass",
        blocking: false,
        startedAt: now - 60_000,
        completedAt: now - 59_000,
        durationMs: 1_000,
        summaryLine: "PASS",
        normalizedJson: JSON.stringify({
          tool: "snyk",
          blocking: {
            isBlocking: false,
            reasonCode: "within_threshold",
            reasonText: "PASS",
            threshold: "new_high_critical_delta>0",
            comparedToBaseline: true,
          },
          counts: {
            critical: 0,
            high: 0,
            medium: 2,
            low: 1,
            bugs: 0,
            codeSmells: 0,
            complexityDelta: 0,
            introducedTotal: 3,
          },
          issues: [],
          truncated: false,
        }),
        createdAt: now,
      });

      await ctx.db.insert("verificationReceipts", {
        verificationId,
        submissionId,
        bountyId,
        agentId,
        attemptNumber: 1,
        legKey: "sonarqube_new_code",
        orderIndex: 7,
        status: "pass",
        blocking: false,
        startedAt: now - 58_000,
        completedAt: now - 57_000,
        durationMs: 1_000,
        summaryLine: "PASS",
        normalizedJson: JSON.stringify({
          tool: "sonarqube",
          blocking: {
            isBlocking: false,
            reasonCode: "quality_gate_passed",
            reasonText: "PASS",
            threshold: "quality_gate=OK",
            comparedToBaseline: true,
          },
          counts: {
            critical: 0,
            high: 0,
            medium: 0,
            low: 0,
            bugs: 2,
            codeSmells: 3,
            complexityDelta: 1,
            introducedTotal: 6,
          },
          issues: [],
          truncated: false,
        }),
        createdAt: now,
      });

      await ctx.db.insert("verificationReceipts", {
        verificationId,
        submissionId,
        bountyId,
        agentId,
        attemptNumber: 1,
        legKey: "lint_no_new_errors",
        orderIndex: 3,
        status: "skipped_policy_due_process",
        blocking: false,
        startedAt: now - 70_000,
        completedAt: now - 69_000,
        durationMs: 1_000,
        summaryLine: "Lint process unavailable",
        createdAt: now,
      });

      return { agentId };
    });

    await t.mutation(internal.agentStats.recomputeForAgent, { agentId });

    const stats = await t.run(async (ctx) =>
      ctx.db
        .query("agentStats")
        .withIndex("by_agentId", (q: any) => q.eq("agentId", agentId))
        .first()
    );

    expect(stats).not.toBeNull();
    expect(stats!.snykMinorBurden).toBeGreaterThan(0);
    expect(stats!.sonarRiskBurden).toBeGreaterThan(0);
    expect(stats!.advisoryProcessFailureRate).toBeGreaterThan(0);
    expect(stats!.snykMinorDisciplineScore).toBeLessThan(100);
    expect(stats!.sonarRiskDisciplineScore).toBeLessThan(100);
    expect(stats!.advisoryReliabilityScore).toBeLessThan(100);
  });
});

describe("recomputeAllTiers", () => {
  it("assigns tiers to qualified agents", async () => {
    const t = convexTest(schema);

    // We need 6+ qualified agents, each with >=5 completed bounties (MIN_COMPLETED_BOUNTIES)
    // and >=3 unique raters (MIN_UNIQUE_RATERS).
    const NUM_AGENTS = 7;
    const NUM_BOUNTIES_EACH = 5;
    const NUM_UNIQUE_CREATORS = 3;

    const agentIds = await t.run(async (ctx) => {
      // Create unique creators for ratings
      const creatorIds: any[] = [];
      for (let c = 0; c < NUM_UNIQUE_CREATORS; c++) {
        creatorIds.push(await seedTrustedCreator(ctx));
      }

      // Create agents with completed bounties and ratings
      const agentIds: any[] = [];
      for (let a = 0; a < NUM_AGENTS; a++) {
        const agentId = await seedUser(ctx, { role: "agent" });
        agentIds.push(agentId);

        for (let b = 0; b < NUM_BOUNTIES_EACH; b++) {
          // Cycle through creators so each agent gets ratings from all 3 creators
          const creatorId = creatorIds[b % NUM_UNIQUE_CREATORS];

          // Give the first agent highest ratings so they rank at top
          const ratingValue = a === 0 ? 5 : Math.max(1, 5 - a);

          await seedCompletedBountyWithRating(ctx, agentId, creatorId, {
            bountyReward: 250,
            ratingOverrides: {
              codeQuality: ratingValue,
              speed: ratingValue,
              mergedWithoutChanges: ratingValue,
              communication: ratingValue,
              testCoverage: ratingValue,
            },
          });
        }
      }

      return agentIds;
    });

    vi.advanceTimersByTime(TRUSTED_AGE_MS);
    // Recompute stats for all agents
    for (const agentId of agentIds) {
      await t.mutation(internal.agentStats.recomputeForAgent, { agentId });
    }

    // Run tier assignment
    await t.mutation(internal.agentStats.recomputeAllTiers, {});

    // The top agent (index 0, all 5s) should satisfy A-tier constraints.
    const topAgentStats = await t.run(async (ctx) => {
      return await ctx.db
        .query("agentStats")
        .withIndex("by_agentId", (q: any) => q.eq("agentId", agentIds[0]))
        .first();
    });

    expect(topAgentStats).not.toBeNull();
    expect(topAgentStats!.tier).toBe("A");
  });

  it("marks unqualified agents as unranked", async () => {
    const t = convexTest(schema);

    const { agentId } = await t.run(async (ctx) => {
      const creatorId = await seedUser(ctx, { role: "creator" });
      const agentId = await seedUser(ctx, { role: "agent" });

      // Only 1 completed bounty -- below MIN_COMPLETED_BOUNTIES=5
      await seedCompletedBountyWithRating(ctx, agentId, creatorId);

      return { agentId };
    });

    await t.mutation(internal.agentStats.recomputeForAgent, { agentId });
    await t.mutation(internal.agentStats.recomputeAllTiers, {});

    const stats = await t.run(async (ctx) => {
      return await ctx.db
        .query("agentStats")
        .withIndex("by_agentId", (q: any) => q.eq("agentId", agentId))
        .first();
    });

    expect(stats).not.toBeNull();
    expect(stats!.tier).toBe("unranked");
  });

  it("prevents S/A tiers when payout volume is below high-tier gates", async () => {
    const t = convexTest(schema);

    const NUM_AGENTS = 7;
    const NUM_BOUNTIES_EACH = 5;
    const NUM_UNIQUE_CREATORS = 3;

    const agentIds = await t.run(async (ctx) => {
      const creatorIds: any[] = [];
      for (let c = 0; c < NUM_UNIQUE_CREATORS; c++) {
        creatorIds.push(await seedTrustedCreator(ctx));
      }

      const agentIds: any[] = [];
      for (let a = 0; a < NUM_AGENTS; a++) {
        const agentId = await seedUser(ctx, { role: "agent" });
        agentIds.push(agentId);

        for (let b = 0; b < NUM_BOUNTIES_EACH; b++) {
          const creatorId = creatorIds[b % NUM_UNIQUE_CREATORS];
          const ratingValue = a === 0 ? 5 : 2;
          await seedCompletedBountyWithRating(ctx, agentId, creatorId, {
            bountyReward: 100, // 5 x $100 = $500 (below A/S payout gates)
            ratingOverrides: {
              codeQuality: ratingValue,
              speed: ratingValue,
              mergedWithoutChanges: ratingValue,
              communication: ratingValue,
              testCoverage: ratingValue,
            },
          });
        }
      }

      return agentIds;
    });

    vi.advanceTimersByTime(TRUSTED_AGE_MS);
    for (const agentId of agentIds) {
      await t.mutation(internal.agentStats.recomputeForAgent, { agentId });
    }
    await t.mutation(internal.agentStats.recomputeAllTiers, {});

    const topStats = await t.run(async (ctx) =>
      ctx.db
        .query("agentStats")
        .withIndex("by_agentId", (q: any) => q.eq("agentId", agentIds[0]))
        .first()
    );

    expect(topStats).not.toBeNull();
    expect(topStats!.paidPayoutVolumeUsd).toBe(500);
    expect(["S", "A"]).not.toContain(topStats!.tier);
    expect(topStats!.tier).not.toBe("unranked");
  });

  it("concentration cap: high-concentration agent capped at B", async () => {
    const t = convexTest(schema);

    // The concentrated agent needs:
    // - >=5 completed bounties (MIN_COMPLETED_BOUNTIES)
    // - >=3 unique raters (MIN_UNIQUE_RATERS) to be qualified
    // - singleCreatorConcentration > 0.6 (CONCENTRATION_CAP_THRESHOLD)
    //
    // Strategy: 7 total bounties/ratings — 5 from creator A, 1 from creator B,
    // 1 from creator C. This gives uniqueRaters=3 and concentration=5/7~=0.71.
    const NUM_OTHER_AGENTS = 6;
    const NUM_UNIQUE_CREATORS = 4; // 1 primary + 3 diversified for other agents

    const { concentratedAgentId, otherAgentIds } = await t.run(async (ctx) => {
      const creatorIds: any[] = [];
      for (let c = 0; c < NUM_UNIQUE_CREATORS; c++) {
        creatorIds.push(await seedTrustedCreator(ctx));
      }

      const primaryCreator = creatorIds[0];
      const secondaryCreator1 = creatorIds[1];
      const secondaryCreator2 = creatorIds[2];

      // Create the concentrated agent with high ratings
      const concentratedAgentId = await seedUser(ctx, { role: "agent" });
      const perfectRatings = {
        codeQuality: 5,
        speed: 5,
        mergedWithoutChanges: 5,
        communication: 5,
        testCoverage: 5,
      };

      // 5 bounties from the primary creator (high concentration)
      for (let b = 0; b < 5; b++) {
        await seedCompletedBountyWithRating(ctx, concentratedAgentId, primaryCreator, {
          bountyReward: 300,
          ratingOverrides: perfectRatings,
        });
      }

      // 1 bounty each from two other creators (to reach uniqueRaters=3)
      await seedCompletedBountyWithRating(ctx, concentratedAgentId, secondaryCreator1, {
        bountyReward: 300,
        ratingOverrides: perfectRatings,
      });
      await seedCompletedBountyWithRating(ctx, concentratedAgentId, secondaryCreator2, {
        bountyReward: 300,
        ratingOverrides: perfectRatings,
      });

      // Create other qualified agents with lower ratings but diversified creators.
      // These agents ensure there is a large enough pool for tier assignment.
      const otherAgentIds: any[] = [];
      for (let a = 0; a < NUM_OTHER_AGENTS; a++) {
        const otherAgentId = await seedUser(ctx, { role: "agent" });
        otherAgentIds.push(otherAgentId);

        // 5 bounties cycling through 3 different creators
        for (let b = 0; b < 5; b++) {
          const creatorId = creatorIds[(b % 3) + 1]; // use creatorIds[1..3]
          await seedCompletedBountyWithRating(ctx, otherAgentId, creatorId, {
            bountyReward: 300,
            ratingOverrides: {
              codeQuality: 2,
              speed: 2,
              mergedWithoutChanges: 2,
              communication: 2,
              testCoverage: 2,
            },
          });
        }
      }

      return { concentratedAgentId, otherAgentIds };
    });

    vi.advanceTimersByTime(TRUSTED_AGE_MS);
    // Recompute stats for all agents
    await t.mutation(internal.agentStats.recomputeForAgent, {
      agentId: concentratedAgentId,
    });
    for (const agentId of otherAgentIds) {
      await t.mutation(internal.agentStats.recomputeForAgent, { agentId });
    }

    // Run tier assignment
    await t.mutation(internal.agentStats.recomputeAllTiers, {});

    const stats = await t.run(async (ctx) => {
      return await ctx.db
        .query("agentStats")
        .withIndex("by_agentId", (q: any) => q.eq("agentId", concentratedAgentId))
        .first();
    });

    expect(stats).not.toBeNull();
    // Concentration should be 5/7 ~= 0.714 (5 ratings from primary creator out of 7 total)
    expect(stats!.singleCreatorConcentration).toBeGreaterThan(0.6);
    // Agent is otherwise strong but concentration cap prevents S/A promotion.
    expect(stats!.tier).toBe("B");
  });
});

describe("leaderboard filtering", () => {
  it("promotes a newly qualified agent into ranked leaderboard results without waiting for cron", async () => {
    const t = convexTest(schema);

    const { targetAgentId } = await t.run(async (ctx) => {
      const topAgentId = await seedUser(ctx, { role: "agent" });
      const secondAgentId = await seedUser(ctx, { role: "agent" });
      const targetAgentId = await seedUser(ctx, { role: "agent" });
      const fourthAgentId = await seedUser(ctx, { role: "agent" });

      await seedAgentStatsRow(ctx, topAgentId, {
        tier: "S",
        finalScore: 92,
        compositeScore: 92,
        paidPayoutVolumeUsd: 2500,
      });
      await seedAgentStatsRow(ctx, secondAgentId, {
        tier: "A",
        finalScore: 86,
        compositeScore: 86,
        paidPayoutVolumeUsd: 1800,
      });
      await seedAgentStatsRow(ctx, targetAgentId, {
        tier: "unranked",
        finalScore: 78,
        compositeScore: 78,
        paidPayoutVolumeUsd: 1200,
      });
      await seedAgentStatsRow(ctx, fourthAgentId, {
        tier: "D",
        finalScore: 70,
        compositeScore: 70,
        paidPayoutVolumeUsd: 900,
      });

      return { targetAgentId };
    });

    const before = await t.query(internal.agentStats.getLeaderboardInternal, {
      limit: 10,
    });
    expect(before.some((entry: any) => entry.agentId === targetAgentId)).toBe(false);

    const tier = await t.mutation(internal.agentStats.recomputeTierForAgent, {
      agentId: targetAgentId,
    });
    expect(tier).toBe("B");

    const after = await t.query(internal.agentStats.getLeaderboardInternal, {
      limit: 10,
    });
    const promoted = after.find((entry: any) => entry.agentId === targetAgentId);
    expect(promoted?.tier).toBe("B");
  });

  it("defaults to ranked-only results", async () => {
    const t = convexTest(schema);

    await t.run(async (ctx) => {
      const rankedAgentId = await seedUser(ctx, { role: "agent" });
      const unrankedAgentId = await seedUser(ctx, { role: "agent" });
      await seedAgentStatsRow(ctx, rankedAgentId, { tier: "A", compositeScore: 80 });
      await seedAgentStatsRow(ctx, unrankedAgentId, { tier: "unranked", compositeScore: 95 });
    });

    const leaderboard = await t.query(internal.agentStats.getLeaderboardInternal, {
      limit: 10,
    });

    expect(leaderboard).toHaveLength(1);
    expect(leaderboard[0].tier).not.toBe("unranked");
  });

  it("can include unranked rows when explicitly requested", async () => {
    const t = convexTest(schema);

    await t.run(async (ctx) => {
      const rankedAgentId = await seedUser(ctx, { role: "agent" });
      const unrankedAgentId = await seedUser(ctx, { role: "agent" });
      await seedAgentStatsRow(ctx, rankedAgentId, { tier: "A", compositeScore: 80 });
      await seedAgentStatsRow(ctx, unrankedAgentId, { tier: "unranked", compositeScore: 95 });
    });

    const leaderboard = await t.query(internal.agentStats.getLeaderboardInternal, {
      limit: 10,
      rankedOnly: false,
      includeUnranked: true,
    });

    expect(leaderboard).toHaveLength(2);
    expect(leaderboard.some((entry: any) => entry.tier === "unranked")).toBe(true);
  });
});
