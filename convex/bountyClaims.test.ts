import { convexTest } from "convex-test";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import { seedUser, seedBounty, seedClaim, seedVerification, seedSubmission } from "./__tests__/helpers";

// markCompleted may schedule async follow-up work in test environments,
// which can surface as unhandled rejections in convex-test. Suppress them.
let rejectionHandler: (err: unknown) => void;
beforeEach(() => {
  rejectionHandler = () => {};
  process.on("unhandledRejection", rejectionHandler);
});
afterEach(() => {
  process.removeListener("unhandledRejection", rejectionHandler);
});

describe("Bounty Claims", () => {
  describe("create", () => {
    it("creates claim on active bounty and sets bounty to in_progress", async () => {
      const t = convexTest(schema);
      const { agentId, bountyId } = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx, { role: "creator" });
        const agentId = await seedUser(ctx, { role: "agent" });
        const bountyId = await seedBounty(ctx, creatorId, {
          status: "active",
        });
        return { agentId, bountyId };
      });

      const claimId = await t.mutation(internal.bountyClaims.create, {
        bountyId,
        agentId,
      });

      expect(claimId).toBeDefined();

      const claim = await t.run(async (ctx) => ctx.db.get(claimId));
      expect(claim?.status).toBe("active");
      expect(claim?.agentId).toBe(agentId);

      const bounty = await t.run(async (ctx) => ctx.db.get(bountyId));
      expect(bounty?.status).toBe("in_progress");
    });

    it("rejects claim on non-active bounty", async () => {
      const t = convexTest(schema);
      const { agentId, bountyId } = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        const agentId = await seedUser(ctx, { role: "agent" });
        const bountyId = await seedBounty(ctx, creatorId, {
          status: "draft",
        });
        return { agentId, bountyId };
      });

      await expect(
        t.mutation(internal.bountyClaims.create, { bountyId, agentId }),
      ).rejects.toThrow("Bounty is not active");
    });

    it("anti-sybil: rejects self-claim (creator = agent)", async () => {
      const t = convexTest(schema);
      const { creatorId, bountyId } = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx, { role: "creator" });
        const bountyId = await seedBounty(ctx, creatorId, {
          status: "active",
        });
        return { creatorId, bountyId };
      });

      await expect(
        t.mutation(internal.bountyClaims.create, {
          bountyId,
          agentId: creatorId,
        }),
      ).rejects.toThrow("cannot claim your own bounty");
    });

    it("rejects when bounty already has active claim", async () => {
      const t = convexTest(schema);
      const { agentId2, bountyId } = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        const agentId1 = await seedUser(ctx, { role: "agent" });
        const agentId2 = await seedUser(ctx, { role: "agent" });
        const bountyId = await seedBounty(ctx, creatorId, {
          status: "active",
        });
        await seedClaim(ctx, bountyId, agentId1, { status: "active" });
        return { agentId2, bountyId };
      });

      await expect(
        t.mutation(internal.bountyClaims.create, {
          bountyId,
          agentId: agentId2,
        }),
      ).rejects.toThrow("already has an active claim");
    });

    it("rejects duplicate claim by same agent", async () => {
      const t = convexTest(schema);
      const { agentId, bountyId } = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        const agentId = await seedUser(ctx, { role: "agent" });
        const bountyId = await seedBounty(ctx, creatorId, {
          status: "active",
        });
        await seedClaim(ctx, bountyId, agentId, { status: "active" });
        return { agentId, bountyId };
      });

      await expect(
        t.mutation(internal.bountyClaims.create, { bountyId, agentId }),
      ).rejects.toThrow("already has an active claim");
    });

    it("tier enforcement: low-tier agent cannot claim high-tier bounty", async () => {
      const t = convexTest(schema);
      const { agentId, bountyId } = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        const agentId = await seedUser(ctx, { role: "agent" });
        const bountyId = await seedBounty(ctx, creatorId, {
          status: "active",
          requiredTier: "A",
        });
        // Agent has no stats (unranked)
        return { agentId, bountyId };
      });

      await expect(
        t.mutation(internal.bountyClaims.create, { bountyId, agentId }),
      ).rejects.toThrow("requires tier");
    });

    it("P0-1: rejects claim when Stripe escrow is not funded", async () => {
      const t = convexTest(schema);
      const { agentId, bountyId } = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx, { role: "creator" });
        const agentId = await seedUser(ctx, { role: "agent" });
        const bountyId = await seedBounty(ctx, creatorId, {
          status: "active",
          paymentMethod: "stripe",
          escrowStatus: "unfunded",
        });
        return { agentId, bountyId };
      });

      await expect(
        t.mutation(internal.bountyClaims.create, { bountyId, agentId }),
      ).rejects.toThrow("escrow is not funded");
    });

    it("P0-1: allows claim on non-Stripe bounty with unfunded escrow", async () => {
      const t = convexTest(schema);
      const { agentId, bountyId } = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx, { role: "creator" });
        const agentId = await seedUser(ctx, { role: "agent" });
        const bountyId = await seedBounty(ctx, creatorId, {
          status: "active",
          paymentMethod: "web3",
          escrowStatus: "unfunded",
        });
        return { agentId, bountyId };
      });

      // web3 bounties don't require funded escrow
      const claimId = await t.mutation(internal.bountyClaims.create, {
        bountyId,
        agentId,
      });
      expect(claimId).toBeDefined();
    });
  });

  describe("release", () => {
    it("reverts bounty to active", async () => {
      const t = convexTest(schema);
      const { agentId, bountyId, claimId } = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        const agentId = await seedUser(ctx, { role: "agent" });
        const bountyId = await seedBounty(ctx, creatorId, {
          status: "in_progress",
        });
        const claimId = await seedClaim(ctx, bountyId, agentId, {
          status: "active",
        });
        return { agentId, bountyId, claimId };
      });

      await t.mutation(internal.bountyClaims.release, {
        claimId,
        agentId,
      });

      const claim = await t.run(async (ctx) => ctx.db.get(claimId));
      expect(claim?.status).toBe("released");

      const bounty = await t.run(async (ctx) => ctx.db.get(bountyId));
      expect(bounty?.status).toBe("active");
    });

    it("rejects release by non-owner", async () => {
      const t = convexTest(schema);
      const { otherAgentId, claimId } = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        const agentId = await seedUser(ctx, { role: "agent" });
        const otherAgentId = await seedUser(ctx, { role: "agent" });
        const bountyId = await seedBounty(ctx, creatorId, {
          status: "in_progress",
        });
        const claimId = await seedClaim(ctx, bountyId, agentId, {
          status: "active",
        });
        return { otherAgentId, claimId };
      });

      await expect(
        t.mutation(internal.bountyClaims.release, {
          claimId,
          agentId: otherAgentId,
        }),
      ).rejects.toThrow("Not your claim");
    });

    it("rejects release of non-active claim", async () => {
      const t = convexTest(schema);
      const { agentId, claimId } = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        const agentId = await seedUser(ctx, { role: "agent" });
        const bountyId = await seedBounty(ctx, creatorId, {
          status: "active",
        });
        const claimId = await seedClaim(ctx, bountyId, agentId, {
          status: "released",
        });
        return { agentId, claimId };
      });

      await expect(
        t.mutation(internal.bountyClaims.release, { claimId, agentId }),
      ).rejects.toThrow("Claim is not active");
    });
  });

  describe("ensureWorkspaceForActiveClaim", () => {
    it("is idempotent when workspace already exists", async () => {
      const t = convexTest(schema);
      const { claimId } = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx, { role: "creator" });
        const agentId = await seedUser(ctx, { role: "agent" });
        const bountyId = await seedBounty(ctx, creatorId, {
          status: "in_progress",
          repositoryUrl: "https://github.com/test/repo",
        });
        const claimId = await seedClaim(ctx, bountyId, agentId, {
          status: "active",
        });
        await ctx.db.insert("devWorkspaces" as any, {
          claimId,
          bountyId,
          agentId,
          workspaceId: "ws_existing",
          workerHost: "",
          status: "provisioning",
          language: "typescript",
          repositoryUrl: "https://github.com/test/repo",
          baseCommitSha: "",
          createdAt: Date.now(),
          expiresAt: Date.now() + 4 * 60 * 60 * 1000,
        });
        return { claimId };
      });

      const result = await t.mutation(internal.bountyClaims.ensureWorkspaceForActiveClaim, {
        claimId,
      });

      expect(result.created).toBe(false);
      expect(result.status).toBe("provisioning");
      expect(result.workspaceId).toBe("ws_existing");
    });

    it("throws when repository URL is missing", async () => {
      const t = convexTest(schema);
      const { claimId } = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx, { role: "creator" });
        const agentId = await seedUser(ctx, { role: "agent" });
        const bountyId = await seedBounty(ctx, creatorId, {
          status: "in_progress",
        });
        const claimId = await seedClaim(ctx, bountyId, agentId, {
          status: "active",
        });
        return { claimId };
      });

      await expect(
        t.mutation(internal.bountyClaims.ensureWorkspaceForActiveClaim, {
          claimId,
        }),
      ).rejects.toThrow("repository URL is not configured");
    });
  });

  describe("expireStale", () => {
    it("expires stale claims past expiresAt", async () => {
      const t = convexTest(schema);
      const { bountyId, claimId } = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        const agentId = await seedUser(ctx, { role: "agent" });
        const bountyId = await seedBounty(ctx, creatorId, {
          status: "in_progress",
        });
        const claimId = await seedClaim(ctx, bountyId, agentId, {
          status: "active",
          expiresAt: Date.now() - 1000, // already expired
        });
        return { bountyId, claimId };
      });

      await t.mutation(internal.bountyClaims.expireStale, {});

      const claim = await t.run(async (ctx) => ctx.db.get(claimId));
      expect(claim?.status).toBe("expired");

      const bounty = await t.run(async (ctx) => ctx.db.get(bountyId));
      expect(bounty?.status).toBe("active");
    });

    it("SECURITY (P1-5): extends claim if verification is running", async () => {
      const t = convexTest(schema);
      const claimId = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        const agentId = await seedUser(ctx, { role: "agent" });
        const bountyId = await seedBounty(ctx, creatorId, {
          status: "in_progress",
        });
        const claimId = await seedClaim(ctx, bountyId, agentId, {
          status: "active",
          expiresAt: Date.now() - 1000,
        });
        // Add a running verification for this bounty
        const submissionId = await seedSubmission(ctx, bountyId, agentId);
        await seedVerification(ctx, submissionId, bountyId, {
          status: "running",
          startedAt: Date.now(),
        });
        return claimId;
      });

      await t.mutation(internal.bountyClaims.expireStale, {});

      const claim = await t.run(async (ctx) => ctx.db.get(claimId));
      // Should still be active, with extended expiry
      expect(claim?.status).toBe("active");
      expect(claim?.expiresAt).toBeGreaterThan(Date.now());
    });
  });

  describe("markCompleted", () => {
    it("sets claim status to completed", async () => {
      const t = convexTest(schema);
      const claimId = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        const agentId = await seedUser(ctx, { role: "agent" });
        const bountyId = await seedBounty(ctx, creatorId, {
          status: "in_progress",
        });
        return await seedClaim(ctx, bountyId, agentId, { status: "active" });
      });

      await t.mutation(internal.bountyClaims.markCompleted, { claimId });

      const claim = await t.run(async (ctx) => ctx.db.get(claimId));
      expect(claim?.status).toBe("completed");
    });

    it("keeps completion behavior unchanged when branch info exists", async () => {
      const t = convexTest(schema);
      const claimId = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        const agentId = await seedUser(ctx, { role: "agent" });
        const bountyId = await seedBounty(ctx, creatorId, {
          status: "in_progress",
        });
        return await seedClaim(ctx, bountyId, agentId, {
          status: "active",
          featureBranchName: "feature/test-branch",
          featureBranchRepo: "owner/repo",
        });
      });

      // Should not throw — branch metadata may still exist after completion.
      await t.mutation(internal.bountyClaims.markCompleted, { claimId });

      const claim = await t.run(async (ctx) => ctx.db.get(claimId));
      expect(claim?.status).toBe("completed");
    });
  });

  describe("extendExpiration", () => {
    it("extends claim by claimDurationHours", async () => {
      const t = convexTest(schema);
      const { agentId, claimId } = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        const agentId = await seedUser(ctx, { role: "agent" });
        const bountyId = await seedBounty(ctx, creatorId, {
          status: "in_progress",
          claimDurationHours: 6,
        });
        const claimId = await seedClaim(ctx, bountyId, agentId, {
          status: "active",
          expiresAt: Date.now() + 1000, // about to expire
        });
        return { agentId, claimId };
      });

      const result = await t.mutation(internal.bountyClaims.extendExpiration, {
        claimId,
        agentId,
      });

      expect(result.expiresAt).toBeGreaterThan(Date.now());
      // 6 hours in ms = 21600000
      const sixHoursMs = 6 * 60 * 60 * 1000;
      // The new expiresAt should be roughly now + 6 hours
      expect(result.expiresAt).toBeGreaterThan(Date.now() + sixHoursMs - 5000);
      expect(result.expiresAt).toBeLessThan(Date.now() + sixHoursMs + 5000);
    });

    it("non-active claim rejected", async () => {
      const t = convexTest(schema);
      const { agentId, claimId } = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        const agentId = await seedUser(ctx, { role: "agent" });
        const bountyId = await seedBounty(ctx, creatorId, {
          status: "active",
        });
        const claimId = await seedClaim(ctx, bountyId, agentId, {
          status: "released",
        });
        return { agentId, claimId };
      });

      await expect(
        t.mutation(internal.bountyClaims.extendExpiration, {
          claimId,
          agentId,
        }),
      ).rejects.toThrow("Claim is not active");
    });
  });
});
