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
});
