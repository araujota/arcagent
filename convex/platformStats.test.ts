import { convexTest } from "convex-test";
import { describe, it, expect } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { seedUser, seedBounty, seedClaim, seedSubmission, seedVerification } from "./__tests__/helpers";

describe("Platform Stats", () => {
  describe("get — default zeros when no data", () => {
    it("returns zero-value object when platformStats table is empty", async () => {
      const t = convexTest(schema);
      const stats = await t.query(api.platformStats.get, {});

      expect(stats.avgTimeToClaimMs).toBe(0);
      expect(stats.avgTimeToSolveMs).toBe(0);
      expect(stats.totalBountiesProcessed).toBe(0);
      expect(stats.totalUsers).toBe(0);
      expect(stats.totalRepos).toBe(0);
      expect(stats.computedAt).toBe(0);
    });
  });

  describe("recompute", () => {
    it("inserts a singleton row on first call with correct totals", async () => {
      const t = convexTest(schema);

      await t.run(async (ctx) => {
        await seedUser(ctx, { role: "creator" });
        await seedUser(ctx, { role: "agent" });
        const creatorId = await seedUser(ctx, { role: "creator" });
        await seedBounty(ctx, creatorId, {
          status: "completed",
          repositoryUrl: "https://github.com/test/repo",
        });
        await seedBounty(ctx, creatorId, {
          status: "active",
          repositoryUrl: "https://github.com/test/repo2",
        });
      });

      await t.mutation(internal.platformStats.recompute, {});

      const stats = await t.query(api.platformStats.get, {});
      expect(stats.totalBountiesProcessed).toBe(1); // only completed
      expect(stats.totalUsers).toBe(3);
      expect(stats.totalRepos).toBe(2);
      expect(stats.computedAt).toBeGreaterThan(0);
    });

    it("updates the singleton row on second call (no duplicate rows)", async () => {
      const t = convexTest(schema);

      await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        await seedBounty(ctx, creatorId, { status: "completed" });
      });

      await t.mutation(internal.platformStats.recompute, {});
      await t.mutation(internal.platformStats.recompute, {});

      const rows = await t.run(async (ctx) =>
        ctx.db.query("platformStats").collect()
      );
      expect(rows).toHaveLength(1); // singleton, not duplicated
    });

    it("deduplicates repos — same URL on multiple bounties counts once", async () => {
      const t = convexTest(schema);
      const REPO = "https://github.com/org/monorepo";

      await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        await seedBounty(ctx, creatorId, { repositoryUrl: REPO });
        await seedBounty(ctx, creatorId, { repositoryUrl: REPO });
        await seedBounty(ctx, creatorId, { repositoryUrl: REPO });
      });

      await t.mutation(internal.platformStats.recompute, {});

      const stats = await t.query(api.platformStats.get, {});
      expect(stats.totalRepos).toBe(1);
    });

    it("ignores bounties without repositoryUrl in repo count", async () => {
      const t = convexTest(schema);

      await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        await seedBounty(ctx, creatorId); // no repositoryUrl
        await seedBounty(ctx, creatorId, {
          repositoryUrl: "https://github.com/org/repo",
        });
      });

      await t.mutation(internal.platformStats.recompute, {});

      const stats = await t.query(api.platformStats.get, {});
      expect(stats.totalRepos).toBe(1);
    });

    it("avgTimeToClaimMs is 0 when no claims have claimedAt", async () => {
      const t = convexTest(schema);

      await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        const agentId = await seedUser(ctx, { role: "agent" });
        const bountyId = await seedBounty(ctx, creatorId);
        // claim with no claimedAt
        await ctx.db.insert("bountyClaims" as any, {
          bountyId,
          agentId,
          status: "active",
          expiresAt: Date.now() + 10000,
          // no claimedAt
        });
      });

      await t.mutation(internal.platformStats.recompute, {});

      const stats = await t.query(api.platformStats.get, {});
      expect(stats.avgTimeToClaimMs).toBe(0);
    });

    it("computes avgTimeToClaimMs correctly from claims with claimedAt", async () => {
      const t = convexTest(schema);
      const CLAIM_DELTA = 60_000; // 1 minute

      await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        const agentId = await seedUser(ctx, { role: "agent" });
        const bountyId = await seedBounty(ctx, creatorId);
        const bounty = await ctx.db.get(bountyId);
        // claimedAt = creationTime + CLAIM_DELTA
        await ctx.db.insert("bountyClaims" as any, {
          bountyId,
          agentId,
          status: "completed",
          claimedAt: bounty!._creationTime + CLAIM_DELTA,
          expiresAt: Date.now() + 10000,
        });
      });

      await t.mutation(internal.platformStats.recompute, {});

      const stats = await t.query(api.platformStats.get, {});
      expect(stats.avgTimeToClaimMs).toBeGreaterThan(0);
    });

    it("avgTimeToSolveMs is 0 when no passed verifications", async () => {
      const t = convexTest(schema);

      await t.mutation(internal.platformStats.recompute, {});

      const stats = await t.query(api.platformStats.get, {});
      expect(stats.avgTimeToSolveMs).toBe(0);
    });
  });
});
