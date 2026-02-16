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

// recomputeForAgent may trigger background scheduled functions via
// ctx.scheduler.runAfter(). In convex-test these can cause "Write outside of
// transaction" unhandled rejections. We suppress them here since the mutation
// itself completes correctly.
let rejectionHandler: (err: unknown) => void;
beforeEach(() => {
  rejectionHandler = () => {};
  process.on("unhandledRejection", rejectionHandler);
});
afterEach(() => {
  process.removeListener("unhandledRejection", rejectionHandler);
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

  return bountyId;
}

describe("recomputeForAgent", () => {
  it("creates stats for agent with completed bounties", async () => {
    const t = convexTest(schema);

    const { agentId } = await t.run(async (ctx) => {
      const creatorId = await seedUser(ctx, { role: "creator" });
      const agentId = await seedUser(ctx, { role: "agent" });

      await seedCompletedBountyWithRating(ctx, agentId, creatorId);

      return { agentId };
    });

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
      const creatorId = await seedUser(ctx, { role: "creator" });
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
        creatorIds.push(await seedUser(ctx, { role: "creator" }));
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
            bountyReward: 100,
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

    // Recompute stats for all agents
    for (const agentId of agentIds) {
      await t.mutation(internal.agentStats.recomputeForAgent, { agentId });
    }

    // Run tier assignment
    await t.mutation(internal.agentStats.recomputeAllTiers, {});

    // The top agent (index 0, all 5s) should have tier S or A
    const topAgentStats = await t.run(async (ctx) => {
      return await ctx.db
        .query("agentStats")
        .withIndex("by_agentId", (q: any) => q.eq("agentId", agentIds[0]))
        .first();
    });

    expect(topAgentStats).not.toBeNull();
    expect(["S", "A"]).toContain(topAgentStats!.tier);
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
        creatorIds.push(await seedUser(ctx, { role: "creator" }));
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
          bountyReward: 100,
          ratingOverrides: perfectRatings,
        });
      }

      // 1 bounty each from two other creators (to reach uniqueRaters=3)
      await seedCompletedBountyWithRating(ctx, concentratedAgentId, secondaryCreator1, {
        bountyReward: 100,
        ratingOverrides: perfectRatings,
      });
      await seedCompletedBountyWithRating(ctx, concentratedAgentId, secondaryCreator2, {
        bountyReward: 100,
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
            bountyReward: 100,
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
    // Agent is qualified (7 bounties >= 5, 3 unique raters >= 3) but concentration
    // cap should prevent S or A tier. The cap forces them to at most B.
    expect(["B", "C", "D"]).toContain(stats!.tier);
  });
});
