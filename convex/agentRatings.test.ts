import { convexTest } from "convex-test";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import { seedUser, seedBounty, seedClaim, seedRating } from "./__tests__/helpers";

// submitRatingFromMcp uses ctx.scheduler.runAfter() which triggers background
// scheduled functions. In convex-test these can cause "Write outside of
// transaction" unhandled rejections. We suppress them here since the mutation
// itself completes correctly — the scheduled side-effects (stats recompute,
// activity feed) are tested separately.
let rejectionHandler: (err: unknown) => void;
beforeEach(() => {
  rejectionHandler = () => {};
  process.on("unhandledRejection", rejectionHandler);
});
afterEach(() => {
  process.removeListener("unhandledRejection", rejectionHandler);
});

describe("submitRatingFromMcp", () => {
  it("successfully rates agent on completed bounty", async () => {
    const t = convexTest(schema);
    const { creatorId, bountyId } = await t.run(async (ctx) => {
      const creatorId = await seedUser(ctx, { role: "creator" });
      const agentId = await seedUser(ctx, { role: "agent" });
      const bountyId = await seedBounty(ctx, creatorId, {
        status: "completed",
        reward: 100,
      });
      await seedClaim(ctx, bountyId, agentId, { status: "completed" });
      return { creatorId, bountyId };
    });

    const ratingId = await t.mutation(internal.agentRatings.submitRatingFromMcp, {
      bountyId,
      creatorId,
      codeQuality: 5,
      speed: 4,
      mergedWithoutChanges: 3,
      communication: 4,
      testCoverage: 5,
      comment: "Great work!",
    });

    expect(ratingId).toBeDefined();

    const rating = await t.run(async (ctx) => ctx.db.get(ratingId));
    expect(rating).not.toBeNull();
    expect(rating!.codeQuality).toBe(5);
    expect(rating!.speed).toBe(4);
    expect(rating!.mergedWithoutChanges).toBe(3);
    expect(rating!.communication).toBe(4);
    expect(rating!.testCoverage).toBe(5);
    expect(rating!.comment).toBe("Great work!");
    expect(rating!.tierEligible).toBe(true);
  });

  it("only bounty creator can rate", async () => {
    const t = convexTest(schema);
    const { otherUserId, bountyId } = await t.run(async (ctx) => {
      const creatorId = await seedUser(ctx, { role: "creator" });
      const agentId = await seedUser(ctx, { role: "agent" });
      const otherUserId = await seedUser(ctx, { role: "creator" });
      const bountyId = await seedBounty(ctx, creatorId, {
        status: "completed",
        reward: 100,
      });
      await seedClaim(ctx, bountyId, agentId, { status: "completed" });
      return { otherUserId, bountyId };
    });

    await expect(
      t.mutation(internal.agentRatings.submitRatingFromMcp, {
        bountyId,
        creatorId: otherUserId,
        codeQuality: 4,
        speed: 4,
        mergedWithoutChanges: 4,
        communication: 4,
        testCoverage: 4,
      }),
    ).rejects.toThrow("Only the bounty creator can rate the agent");
  });

  it("only completed bounties can be rated", async () => {
    const t = convexTest(schema);
    const { creatorId, bountyId } = await t.run(async (ctx) => {
      const creatorId = await seedUser(ctx, { role: "creator" });
      const bountyId = await seedBounty(ctx, creatorId, {
        status: "in_progress",
        reward: 100,
      });
      return { creatorId, bountyId };
    });

    await expect(
      t.mutation(internal.agentRatings.submitRatingFromMcp, {
        bountyId,
        creatorId,
        codeQuality: 4,
        speed: 4,
        mergedWithoutChanges: 4,
        communication: 4,
        testCoverage: 4,
      }),
    ).rejects.toThrow("Can only rate agents on completed bounties");
  });

  it("no duplicate ratings for the same bounty", async () => {
    const t = convexTest(schema);
    const { creatorId, bountyId } = await t.run(async (ctx) => {
      const creatorId = await seedUser(ctx, { role: "creator" });
      const agentId = await seedUser(ctx, { role: "agent" });
      const bountyId = await seedBounty(ctx, creatorId, {
        status: "completed",
        reward: 100,
      });
      await seedClaim(ctx, bountyId, agentId, { status: "completed" });
      // Insert an existing rating
      await seedRating(ctx, bountyId, agentId, creatorId);
      return { creatorId, bountyId };
    });

    await expect(
      t.mutation(internal.agentRatings.submitRatingFromMcp, {
        bountyId,
        creatorId,
        codeQuality: 5,
        speed: 5,
        mergedWithoutChanges: 5,
        communication: 5,
        testCoverage: 5,
      }),
    ).rejects.toThrow("A rating already exists for this bounty");
  });

  it("self-rating is blocked (creator === agent)", async () => {
    const t = convexTest(schema);
    const { creatorId, bountyId } = await t.run(async (ctx) => {
      // Same user is both creator and agent
      const creatorId = await seedUser(ctx, { role: "creator" });
      const bountyId = await seedBounty(ctx, creatorId, {
        status: "completed",
        reward: 100,
      });
      // The completed claim has the same user as the agent
      await seedClaim(ctx, bountyId, creatorId, { status: "completed" });
      return { creatorId, bountyId };
    });

    await expect(
      t.mutation(internal.agentRatings.submitRatingFromMcp, {
        bountyId,
        creatorId,
        codeQuality: 5,
        speed: 5,
        mergedWithoutChanges: 5,
        communication: 5,
        testCoverage: 5,
      }),
    ).rejects.toThrow("Cannot rate yourself");
  });

  it("dimension value 0 is rejected", async () => {
    const t = convexTest(schema);
    const { creatorId, bountyId } = await t.run(async (ctx) => {
      const creatorId = await seedUser(ctx, { role: "creator" });
      const agentId = await seedUser(ctx, { role: "agent" });
      const bountyId = await seedBounty(ctx, creatorId, {
        status: "completed",
        reward: 100,
      });
      await seedClaim(ctx, bountyId, agentId, { status: "completed" });
      return { creatorId, bountyId };
    });

    await expect(
      t.mutation(internal.agentRatings.submitRatingFromMcp, {
        bountyId,
        creatorId,
        codeQuality: 0,
        speed: 4,
        mergedWithoutChanges: 4,
        communication: 4,
        testCoverage: 4,
      }),
    ).rejects.toThrow("codeQuality must be an integer between 1 and 5");
  });

  it("dimension value 6 is rejected", async () => {
    const t = convexTest(schema);
    const { creatorId, bountyId } = await t.run(async (ctx) => {
      const creatorId = await seedUser(ctx, { role: "creator" });
      const agentId = await seedUser(ctx, { role: "agent" });
      const bountyId = await seedBounty(ctx, creatorId, {
        status: "completed",
        reward: 100,
      });
      await seedClaim(ctx, bountyId, agentId, { status: "completed" });
      return { creatorId, bountyId };
    });

    await expect(
      t.mutation(internal.agentRatings.submitRatingFromMcp, {
        bountyId,
        creatorId,
        codeQuality: 4,
        speed: 6,
        mergedWithoutChanges: 4,
        communication: 4,
        testCoverage: 4,
      }),
    ).rejects.toThrow("speed must be an integer between 1 and 5");
  });

  it("tier-ineligible if reward < $50", async () => {
    const t = convexTest(schema);
    const { creatorId, bountyId } = await t.run(async (ctx) => {
      const creatorId = await seedUser(ctx, { role: "creator" });
      const agentId = await seedUser(ctx, { role: "agent" });
      const bountyId = await seedBounty(ctx, creatorId, {
        status: "completed",
        reward: 20, // Below MIN_TIER_ELIGIBLE_REWARD of 50
      });
      await seedClaim(ctx, bountyId, agentId, { status: "completed" });
      return { creatorId, bountyId };
    });

    const ratingId = await t.mutation(internal.agentRatings.submitRatingFromMcp, {
      bountyId,
      creatorId,
      codeQuality: 5,
      speed: 5,
      mergedWithoutChanges: 5,
      communication: 5,
      testCoverage: 5,
    });

    const rating = await t.run(async (ctx) => ctx.db.get(ratingId));
    expect(rating!.tierEligible).toBe(false);
  });
});
