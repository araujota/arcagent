import { convexTest } from "convex-test";
import { describe, it, expect } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import { seedUser, seedBounty, seedSubmission, seedVerification } from "./__tests__/helpers";

describe("platformStats.recompute", () => {
  it("computes claim/solve/repo/user aggregates", async () => {
    const t = convexTest(schema);

    await t.run(async (ctx) => {
      const creatorId = await seedUser(ctx, { role: "creator" });
      const agentId = await seedUser(ctx, { role: "agent" });

      const bountyId = await seedBounty(ctx, creatorId, {
        status: "completed",
        repositoryUrl: "https://github.com/example/repo",
      });
      const now = Date.now();

      await ctx.db.insert("bountyClaims", {
        bountyId,
        agentId,
        status: "completed",
        claimedAt: now + 1_000,
        expiresAt: now + 60_000,
      });

      const submissionId = await seedSubmission(ctx, bountyId, agentId, {
        status: "passed",
      });

      await seedVerification(ctx, submissionId, bountyId, {
        status: "passed",
        completedAt: now + 2_000,
        timeoutSeconds: 600,
      });
    });

    await t.mutation(internal.platformStats.recompute, {});

    const stats = await t.query(internal.platformStats.get, {});
    expect(stats.totalBountiesProcessed).toBe(1);
    expect(stats.totalUsers).toBe(2);
    expect(stats.totalRepos).toBe(1);
    expect(stats.avgTimeToClaimMs).toBeGreaterThanOrEqual(0);
    expect(stats.avgTimeToSolveMs).toBeGreaterThanOrEqual(0);
    expect(stats.computedAt).toBeGreaterThan(0);
  });

  it("excludes test bounties from timing, but keeps users/repos as global totals", async () => {
    const t = convexTest(schema);

    await t.run(async (ctx) => {
      const creatorId = await seedUser(ctx, { role: "creator" });
      const liveAgentId = await seedUser(ctx, { role: "agent" });
      const testOnlyAgentId = await seedUser(ctx, { role: "agent" });

      const liveBountyId = await seedBounty(ctx, creatorId, {
        status: "completed",
        repositoryUrl: "https://github.com/example/live-repo",
      });
      const testBountyId = await seedBounty(ctx, creatorId, {
        status: "completed",
        repositoryUrl: "https://github.com/example/test-repo",
        isTestBounty: true,
      });

      const now = Date.now();

      await ctx.db.insert("bountyClaims", {
        bountyId: liveBountyId,
        agentId: liveAgentId,
        status: "completed",
        claimedAt: now + 1_000,
        expiresAt: now + 60_000,
      });
      const liveSubmissionId = await seedSubmission(ctx, liveBountyId, liveAgentId, {
        status: "passed",
      });
      await seedVerification(ctx, liveSubmissionId, liveBountyId, {
        status: "passed",
        completedAt: now + 2_000,
        timeoutSeconds: 600,
      });

      // Intentionally massive deltas on the test bounty to ensure it would skew
      // averages if test records were included.
      await ctx.db.insert("bountyClaims", {
        bountyId: testBountyId,
        agentId: testOnlyAgentId,
        status: "completed",
        claimedAt: now + 5_000_000,
        expiresAt: now + 5_060_000,
      });
      const testSubmissionId = await seedSubmission(ctx, testBountyId, testOnlyAgentId, {
        status: "passed",
      });
      await seedVerification(ctx, testSubmissionId, testBountyId, {
        status: "passed",
        completedAt: now + 10_000_000,
        timeoutSeconds: 600,
      });
    });

    await t.mutation(internal.platformStats.recompute, {});

    const stats = await t.query(internal.platformStats.get, {});
    expect(stats.totalBountiesProcessed).toBe(1);
    expect(stats.totalRepos).toBe(2);
    expect(stats.totalUsers).toBe(3);
    expect(stats.avgTimeToClaimMs).toBeLessThan(60_000);
    expect(stats.avgTimeToSolveMs).toBeLessThan(60_000);
  });
});
