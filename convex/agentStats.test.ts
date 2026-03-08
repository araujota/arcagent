import { convexTest } from "convex-test";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
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

let rejectionHandler: (err: unknown) => void;
beforeEach(() => {
  rejectionHandler = () => {};
  process.on("unhandledRejection", rejectionHandler);
});
afterEach(() => {
  process.removeListener("unhandledRejection", rejectionHandler);
});

async function seedCompletedClaim(
  ctx: any,
  agentId: any,
  creatorId: any,
  options: {
    reward?: number;
    claimDurationHours?: number;
    claimedAtOffsetMs?: number;
    completedAtOffsetMs?: number;
    tierEligible?: boolean;
    ratingOverrides?: Record<string, unknown>;
  } = {},
) {
  const now = Date.now();
  const claimedAt = now - (options.claimedAtOffsetMs ?? 2 * 60 * 60 * 1000);
  const completedAt = now - (options.completedAtOffsetMs ?? 0);

  const bountyId = await seedBounty(ctx, creatorId, {
    status: "completed",
    reward: options.reward ?? 100,
    claimDurationHours: options.claimDurationHours ?? 4,
  });
  await seedClaim(ctx, bountyId, agentId, {
    status: "completed",
    claimedAt,
  });
  const submissionId = await seedSubmission(ctx, bountyId, agentId, {
    status: "passed",
  });
  await seedVerification(ctx, submissionId, bountyId, {
    status: "passed",
    completedAt,
  });
  await seedRating(ctx, bountyId, agentId, creatorId, {
    tierEligible: options.tierEligible ?? true,
    createdAt: now,
    ...(options.ratingOverrides ?? {}),
  });
}

async function seedFailedTerminalClaim(
  ctx: any,
  agentId: any,
  creatorId: any,
  status: "released" | "expired",
) {
  const bountyId = await seedBounty(ctx, creatorId, {
    status: "active",
    reward: 100,
  });
  await seedClaim(ctx, bountyId, agentId, {
    status,
    claimedAt: Date.now() - 60 * 60 * 1000,
  });
  const submissionId = await seedSubmission(ctx, bountyId, agentId, {
    status: "failed",
  });
  await seedVerification(ctx, submissionId, bountyId, {
    status: "failed",
    completedAt: Date.now(),
  });
}

describe("recomputeForAgent", () => {
  it("computes trust-oriented rating dimensions", async () => {
    const t = convexTest(schema);
    const { agentId } = await t.run(async (ctx) => {
      const creatorIds = await Promise.all([
        seedUser(ctx, { role: "creator" }),
        seedUser(ctx, { role: "creator" }),
        seedUser(ctx, { role: "creator" }),
      ]);
      const agentId = await seedUser(ctx, { role: "agent" });

      for (const creatorId of creatorIds) {
        await seedCompletedClaim(ctx, agentId, creatorId, {
          ratingOverrides: {
            codeQuality: 5,
            speed: 4,
            mergedWithoutChanges: 5,
            communication: 3,
            testCoverage: 4,
          },
        });
      }

      return { agentId };
    });

    await t.mutation(internal.agentStats.recomputeForAgent, { agentId });

    const stats = await t.run(async (ctx) =>
      ctx.db.query("agentStats").withIndex("by_agentId", (q: any) => q.eq("agentId", agentId)).first(),
    );

    expect(stats).not.toBeNull();
    expect(stats!.avgMergeReadinessRating).toBeCloseTo(5, 5);
    expect(stats!.avgCodeQualityRating).toBeCloseTo(5, 5);
    expect(stats!.avgTestCoverageRating).toBeCloseTo(4, 5);
    expect(stats!.avgCommunicationRating).toBeCloseTo(3, 5);
    expect(stats!.avgSpeedRating).toBeCloseTo(4, 5);
    expect(stats!.trustScore).toBeCloseTo(stats!.compositeScore, 10);
  });

  it("uses only eligible raters for qualification", async () => {
    const t = convexTest(schema);
    const { agentId } = await t.run(async (ctx) => {
      const creators = await Promise.all([
        seedUser(ctx, { role: "creator" }),
        seedUser(ctx, { role: "creator" }),
        seedUser(ctx, { role: "creator" }),
      ]);
      const agentId = await seedUser(ctx, { role: "agent" });

      await seedCompletedClaim(ctx, agentId, creators[0]);
      await seedCompletedClaim(ctx, agentId, creators[0]);
      await seedCompletedClaim(ctx, agentId, creators[1]);
      await seedCompletedClaim(ctx, agentId, creators[1]);
      await seedCompletedClaim(ctx, agentId, creators[2], {
        reward: 20,
        tierEligible: false,
      });

      return { agentId };
    });

    await t.mutation(internal.agentStats.recomputeForAgent, { agentId });
    await t.mutation(internal.agentStats.recomputeAllTiers, {});

    const stats = await t.run(async (ctx) =>
      ctx.db.query("agentStats").withIndex("by_agentId", (q: any) => q.eq("agentId", agentId)).first(),
    );

    expect(stats).not.toBeNull();
    expect(stats!.uniqueRaters).toBe(3);
    expect(stats!.eligibleUniqueRaters).toBe(2);
    expect(stats!.tier).toBe("unranked");
  });

  it("does not let released or expired claims escape verification reliability", async () => {
    const t = convexTest(schema);
    const { agentId } = await t.run(async (ctx) => {
      const creators = await Promise.all([
        seedUser(ctx, { role: "creator" }),
        seedUser(ctx, { role: "creator" }),
        seedUser(ctx, { role: "creator" }),
      ]);
      const agentId = await seedUser(ctx, { role: "agent" });

      for (const creatorId of creators) {
        await seedCompletedClaim(ctx, agentId, creatorId);
      }
      await seedFailedTerminalClaim(ctx, agentId, creators[0], "released");
      await seedFailedTerminalClaim(ctx, agentId, creators[1], "expired");

      return { agentId };
    });

    await t.mutation(internal.agentStats.recomputeForAgent, { agentId });

    const stats = await t.run(async (ctx) =>
      ctx.db.query("agentStats").withIndex("by_agentId", (q: any) => q.eq("agentId", agentId)).first(),
    );

    expect(stats).not.toBeNull();
    expect(stats!.verificationReliabilityRate).toBeCloseTo(3 / 5, 5);
    expect(stats!.claimReliabilityRate).toBeCloseTo(3 / 5, 5);
    expect(stats!.firstAttemptPassRate).toBeCloseTo(3 / 5, 5);
  });

  it("trust score does not depend on claim duration", async () => {
    const t = convexTest(schema);
    const { fastAgentId, slowWindowAgentId } = await t.run(async (ctx) => {
      const creators = await Promise.all([
        seedUser(ctx, { role: "creator" }),
        seedUser(ctx, { role: "creator" }),
        seedUser(ctx, { role: "creator" }),
      ]);
      const fastAgentId = await seedUser(ctx, { role: "agent" });
      const slowWindowAgentId = await seedUser(ctx, { role: "agent" });

      for (const creatorId of creators) {
        await seedCompletedClaim(ctx, fastAgentId, creatorId, {
          claimDurationHours: 4,
          claimedAtOffsetMs: 2 * 60 * 60 * 1000,
        });
        await seedCompletedClaim(ctx, slowWindowAgentId, creatorId, {
          claimDurationHours: 12,
          claimedAtOffsetMs: 2 * 60 * 60 * 1000,
        });
      }

      return { fastAgentId, slowWindowAgentId };
    });

    await t.mutation(internal.agentStats.recomputeForAgent, { agentId: fastAgentId });
    await t.mutation(internal.agentStats.recomputeForAgent, {
      agentId: slowWindowAgentId,
    });

    const [fastStats, slowWindowStats] = await t.run(async (ctx) =>
      Promise.all([
        ctx.db
          .query("agentStats")
          .withIndex("by_agentId", (q: any) => q.eq("agentId", fastAgentId))
          .first(),
        ctx.db
          .query("agentStats")
          .withIndex("by_agentId", (q: any) => q.eq("agentId", slowWindowAgentId))
          .first(),
      ]),
    );

    expect(fastStats!.avgTimeToResolutionMs).toBeCloseTo(slowWindowStats!.avgTimeToResolutionMs, -2);
    expect(fastStats!.trustScore).toBeCloseTo(slowWindowStats!.trustScore, 5);
  });
});

describe("recomputeAllTiers and leaderboard", () => {
  it("assigns absolute trust-based tiers and confidence levels", async () => {
    const t = convexTest(schema);
    const { strongAgentId, mediumAgentId, lowAgentId } = await t.run(async (ctx) => {
      const creators = await Promise.all(
        Array.from({ length: 8 }, () => seedUser(ctx, { role: "creator" })),
      );
      const strongAgentId = await seedUser(ctx, { role: "agent" });
      const mediumAgentId = await seedUser(ctx, { role: "agent" });
      const lowAgentId = await seedUser(ctx, { role: "agent" });

      for (let i = 0; i < 25; i++) {
        await seedCompletedClaim(ctx, strongAgentId, creators[i % creators.length], {
          ratingOverrides: {
            codeQuality: 5,
            speed: 5,
            mergedWithoutChanges: 5,
            communication: 4,
            testCoverage: 5,
          },
        });
      }

      for (let i = 0; i < 10; i++) {
        await seedCompletedClaim(ctx, mediumAgentId, creators[i % 6], {
          ratingOverrides: {
            codeQuality: 5,
            speed: 4,
            mergedWithoutChanges: 5,
            communication: 4,
            testCoverage: 5,
          },
        });
      }

      for (let i = 0; i < 5; i++) {
        await seedCompletedClaim(ctx, lowAgentId, creators[i % 3], {
          ratingOverrides: {
            codeQuality: 3,
            speed: 3,
            mergedWithoutChanges: 3,
            communication: 3,
            testCoverage: 3,
          },
        });
      }

      return { strongAgentId, mediumAgentId, lowAgentId };
    });

    for (const agentId of [strongAgentId, mediumAgentId, lowAgentId]) {
      await t.mutation(internal.agentStats.recomputeForAgent, { agentId });
    }
    await t.mutation(internal.agentStats.recomputeAllTiers, {});

    const [strongStats, mediumStats, lowStats] = await t.run(async (ctx) =>
      Promise.all([
        ctx.db
          .query("agentStats")
          .withIndex("by_agentId", (q: any) => q.eq("agentId", strongAgentId))
          .first(),
        ctx.db
          .query("agentStats")
          .withIndex("by_agentId", (q: any) => q.eq("agentId", mediumAgentId))
          .first(),
        ctx.db
          .query("agentStats")
          .withIndex("by_agentId", (q: any) => q.eq("agentId", lowAgentId))
          .first(),
      ]),
    );

    expect(strongStats!.confidenceLevel).toBe("high");
    expect(strongStats!.tier).toBe("S");
    expect(mediumStats!.confidenceLevel).toBe("medium");
    expect(["A", "B"]).toContain(mediumStats!.tier);
    expect(lowStats!.confidenceLevel).toBe("low");
    expect(["C", "D"]).toContain(lowStats!.tier);
  });

  it("caps concentrated agents at B tier", async () => {
    const t = convexTest(schema);
    const { concentratedAgentId, otherAgentId } = await t.run(async (ctx) => {
      const creators = await Promise.all(
        Array.from({ length: 4 }, () => seedUser(ctx, { role: "creator" })),
      );
      const concentratedAgentId = await seedUser(ctx, { role: "agent" });
      const otherAgentId = await seedUser(ctx, { role: "agent" });

      for (let i = 0; i < 5; i++) {
        await seedCompletedClaim(ctx, concentratedAgentId, creators[0], {
          ratingOverrides: {
            codeQuality: 5,
            speed: 5,
            mergedWithoutChanges: 5,
            communication: 5,
            testCoverage: 5,
          },
        });
      }
      await seedCompletedClaim(ctx, concentratedAgentId, creators[1]);
      await seedCompletedClaim(ctx, concentratedAgentId, creators[2]);

      for (let i = 0; i < 8; i++) {
        await seedCompletedClaim(ctx, otherAgentId, creators[i % creators.length], {
          ratingOverrides: {
            codeQuality: 4,
            speed: 4,
            mergedWithoutChanges: 4,
            communication: 4,
            testCoverage: 4,
          },
        });
      }

      return { concentratedAgentId, otherAgentId };
    });

    await t.mutation(internal.agentStats.recomputeForAgent, {
      agentId: concentratedAgentId,
    });
    await t.mutation(internal.agentStats.recomputeForAgent, { agentId: otherAgentId });
    await t.mutation(internal.agentStats.recomputeAllTiers, {});

    const stats = await t.run(async (ctx) =>
      ctx.db
        .query("agentStats")
        .withIndex("by_agentId", (q: any) => q.eq("agentId", concentratedAgentId))
        .first(),
    );

    expect(stats!.singleCreatorConcentration).toBeGreaterThan(0.6);
    expect(["B", "C", "D"]).toContain(stats!.tier);
  });

  it("filters unranked agents from the leaderboard", async () => {
    const t = convexTest(schema);
    const { rankedAgentId, unrankedAgentId } = await t.run(async (ctx) => {
      const creators = await Promise.all([
        seedUser(ctx, { role: "creator" }),
        seedUser(ctx, { role: "creator" }),
        seedUser(ctx, { role: "creator" }),
      ]);
      const rankedAgentId = await seedUser(ctx, { role: "agent" });
      const unrankedAgentId = await seedUser(ctx, { role: "agent" });

      for (let i = 0; i < 5; i++) {
        await seedCompletedClaim(ctx, rankedAgentId, creators[i % creators.length]);
      }
      await seedCompletedClaim(ctx, unrankedAgentId, creators[0]);

      return { rankedAgentId, unrankedAgentId };
    });

    await t.mutation(internal.agentStats.recomputeForAgent, { agentId: rankedAgentId });
    await t.mutation(internal.agentStats.recomputeForAgent, { agentId: unrankedAgentId });
    await t.mutation(internal.agentStats.recomputeAllTiers, {});

    const leaderboard = await t.query(internal.agentStats.getLeaderboardInternal, { limit: 10 });

    expect(leaderboard.some((entry) => entry.agentId === rankedAgentId)).toBe(true);
    expect(leaderboard.some((entry) => entry.agentId === unrankedAgentId)).toBe(false);
  });
});
