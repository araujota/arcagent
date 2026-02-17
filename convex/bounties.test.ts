import { convexTest } from "convex-test";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { seedUser, seedBounty, seedClaim, seedSubmission } from "./__tests__/helpers";

// cancelFromMcp uses ctx.scheduler.runAfter() for refund/cleanup which can
// cause "Write outside of transaction" errors in convex-test. Suppress them.
let rejectionHandler: (err: unknown) => void;
beforeEach(() => {
  rejectionHandler = () => {};
  process.on("unhandledRejection", rejectionHandler);
});
afterEach(() => {
  process.removeListener("unhandledRejection", rejectionHandler);
});

describe("Bounty Status Transitions", () => {
  describe("updateStatusInternal", () => {
    it("draft -> active succeeds (with funded escrow, tosAccepted)", async () => {
      const t = convexTest(schema);
      const bountyId = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        return await seedBounty(ctx, creatorId, {
          status: "draft",
          escrowStatus: "funded",
          tosAccepted: true,
        });
      });

      await t.mutation(internal.bounties.updateStatusInternal, {
        bountyId,
        status: "active",
      });

      const bounty = await t.run(async (ctx) => ctx.db.get(bountyId));
      expect(bounty?.status).toBe("active");
    });

    it("active -> in_progress succeeds", async () => {
      const t = convexTest(schema);
      const bountyId = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        return await seedBounty(ctx, creatorId, { status: "active" });
      });

      await t.mutation(internal.bounties.updateStatusInternal, {
        bountyId,
        status: "in_progress",
      });

      const bounty = await t.run(async (ctx) => ctx.db.get(bountyId));
      expect(bounty?.status).toBe("in_progress");
    });

    it("in_progress -> completed succeeds", async () => {
      const t = convexTest(schema);
      const bountyId = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        return await seedBounty(ctx, creatorId, { status: "in_progress" });
      });

      await t.mutation(internal.bounties.updateStatusInternal, {
        bountyId,
        status: "completed",
      });

      const bounty = await t.run(async (ctx) => ctx.db.get(bountyId));
      expect(bounty?.status).toBe("completed");
    });

    it("active -> cancelled succeeds", async () => {
      const t = convexTest(schema);
      const bountyId = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        return await seedBounty(ctx, creatorId, { status: "active" });
      });

      await t.mutation(internal.bounties.updateStatusInternal, {
        bountyId,
        status: "cancelled",
      });

      const bounty = await t.run(async (ctx) => ctx.db.get(bountyId));
      expect(bounty?.status).toBe("cancelled");
    });

    it("draft -> completed throws (invalid)", async () => {
      const t = convexTest(schema);
      const bountyId = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        return await seedBounty(ctx, creatorId, { status: "draft" });
      });

      await expect(
        t.mutation(internal.bounties.updateStatusInternal, {
          bountyId,
          status: "completed",
        }),
      ).rejects.toThrow("Cannot transition");
    });

    it("completed -> active throws (terminal state)", async () => {
      const t = convexTest(schema);
      const bountyId = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        return await seedBounty(ctx, creatorId, { status: "completed" });
      });

      await expect(
        t.mutation(internal.bounties.updateStatusInternal, {
          bountyId,
          status: "active",
        }),
      ).rejects.toThrow("Cannot transition");
    });

    it("cancelled -> active throws (terminal state)", async () => {
      const t = convexTest(schema);
      const bountyId = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        return await seedBounty(ctx, creatorId, { status: "cancelled" });
      });

      await expect(
        t.mutation(internal.bounties.updateStatusInternal, {
          bountyId,
          status: "active",
        }),
      ).rejects.toThrow("Cannot transition");
    });

    it("active -> completed throws (invalid -- must go through in_progress)", async () => {
      const t = convexTest(schema);
      const bountyId = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        return await seedBounty(ctx, creatorId, { status: "active" });
      });

      await expect(
        t.mutation(internal.bounties.updateStatusInternal, {
          bountyId,
          status: "completed",
        }),
      ).rejects.toThrow("Cannot transition");
    });

    it("SECURITY (H1): blocks activation of unfunded Stripe bounty", async () => {
      const t = convexTest(schema);
      const bountyId = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        return await seedBounty(ctx, creatorId, {
          status: "draft",
          paymentMethod: "stripe",
          escrowStatus: "unfunded",
        });
      });

      await expect(
        t.mutation(internal.bounties.updateStatusInternal, {
          bountyId,
          status: "active",
        }),
      ).rejects.toThrow("escrow must be funded");
    });
  });

  describe("createFromMcp", () => {
    it("creates bounty with valid inputs", async () => {
      const t = convexTest(schema);
      const creatorId = await t.run(async (ctx) => {
        return await seedUser(ctx, { role: "creator" });
      });

      const bountyId = await t.mutation(internal.bounties.createFromMcp, {
        creatorId,
        title: "Fix authentication bug",
        description: "The login form fails when special chars are used in passwords",
        reward: 100,
        rewardCurrency: "USD",
        paymentMethod: "stripe",
        status: "draft",
      });

      expect(bountyId).toBeDefined();
      const bounty = await t.run(async (ctx) => ctx.db.get(bountyId));
      expect(bounty?.title).toBe("Fix authentication bug");
      expect(bounty?.status).toBe("draft");
    });

    it("throws if reward < $50", async () => {
      const t = convexTest(schema);
      const creatorId = await t.run(async (ctx) => seedUser(ctx));

      await expect(
        t.mutation(internal.bounties.createFromMcp, {
          creatorId,
          title: "Cheap bounty",
          description: "A test bounty description that is long enough",
          reward: 25,
          rewardCurrency: "USD",
          paymentMethod: "stripe",
        }),
      ).rejects.toThrow("Minimum bounty reward");
    });

    it("throws if S-tier < $150", async () => {
      const t = convexTest(schema);
      const creatorId = await t.run(async (ctx) => seedUser(ctx));

      await expect(
        t.mutation(internal.bounties.createFromMcp, {
          creatorId,
          title: "S-tier bounty",
          description: "A test bounty description that is long enough",
          reward: 100,
          rewardCurrency: "USD",
          paymentMethod: "stripe",
          requiredTier: "S",
        }),
      ).rejects.toThrow("S-Tier bounties require a minimum reward");
    });

    it("throws if title is empty/whitespace", async () => {
      const t = convexTest(schema);
      const creatorId = await t.run(async (ctx) => seedUser(ctx));

      await expect(
        t.mutation(internal.bounties.createFromMcp, {
          creatorId,
          title: "   ",
          description: "A test bounty description that is long enough",
          reward: 100,
          rewardCurrency: "USD",
          paymentMethod: "stripe",
        }),
      ).rejects.toThrow("Title is required");
    });

    it("throws if description too short", async () => {
      const t = convexTest(schema);
      const creatorId = await t.run(async (ctx) => seedUser(ctx));

      await expect(
        t.mutation(internal.bounties.createFromMcp, {
          creatorId,
          title: "Valid title",
          description: "short",
          reward: 100,
          rewardCurrency: "USD",
          paymentMethod: "stripe",
        }),
      ).rejects.toThrow("Description too short");
    });

    it("throws if deadline is in the past", async () => {
      const t = convexTest(schema);
      const creatorId = await t.run(async (ctx) => seedUser(ctx));

      await expect(
        t.mutation(internal.bounties.createFromMcp, {
          creatorId,
          title: "Valid title",
          description: "A test bounty description that is long enough",
          reward: 100,
          rewardCurrency: "USD",
          paymentMethod: "stripe",
          deadline: Date.now() - 100000,
        }),
      ).rejects.toThrow("Deadline must be in the future");
    });

    it("throws for web3 payment method", async () => {
      const t = convexTest(schema);
      const creatorId = await t.run(async (ctx) => seedUser(ctx));

      await expect(
        t.mutation(internal.bounties.createFromMcp, {
          creatorId,
          title: "Web3 bounty",
          description: "A test bounty description that is long enough",
          reward: 100,
          rewardCurrency: "USD",
          paymentMethod: "web3",
        }),
      ).rejects.toThrow("Web3 payments are coming soon");
    });

    it("P1-1: defaults status to 'draft' when not specified", async () => {
      const t = convexTest(schema);
      const creatorId = await t.run(async (ctx) => seedUser(ctx));

      const bountyId = await t.mutation(internal.bounties.createFromMcp, {
        creatorId,
        title: "No explicit status",
        description: "A test bounty description that is long enough",
        reward: 100,
        rewardCurrency: "USD",
        paymentMethod: "stripe",
      });

      const bounty = await t.run(async (ctx) => ctx.db.get(bountyId));
      expect(bounty?.status).toBe("draft");
    });

    it("P1-1: Stripe bounty with status='active' and unfunded escrow throws", async () => {
      const t = convexTest(schema);
      const creatorId = await t.run(async (ctx) => seedUser(ctx));

      await expect(
        t.mutation(internal.bounties.createFromMcp, {
          creatorId,
          title: "Active unfunded",
          description: "A test bounty description that is long enough",
          reward: 100,
          rewardCurrency: "USD",
          paymentMethod: "stripe",
          status: "active",
        }),
      ).rejects.toThrow();
    });
  });

  describe("cancelFromMcp", () => {
    it("cancels active bounty with no claims", async () => {
      const t = convexTest(schema);
      const { creatorId, bountyId } = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        const bountyId = await seedBounty(ctx, creatorId, {
          status: "active",
          escrowStatus: "unfunded",
        });
        return { creatorId, bountyId };
      });

      const result = await t.mutation(internal.bounties.cancelFromMcp, {
        bountyId,
        creatorId,
      });

      expect(result.bountyId).toBe(bountyId);
      const bounty = await t.run(async (ctx) => ctx.db.get(bountyId));
      expect(bounty?.status).toBe("cancelled");
    });

    it("rejects cancellation of completed bounty", async () => {
      const t = convexTest(schema);
      const { creatorId, bountyId } = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        const bountyId = await seedBounty(ctx, creatorId, {
          status: "completed",
        });
        return { creatorId, bountyId };
      });

      await expect(
        t.mutation(internal.bounties.cancelFromMcp, { bountyId, creatorId }),
      ).rejects.toThrow("Cannot cancel a completed bounty");
    });

    it("rejects cancellation with active claim", async () => {
      const t = convexTest(schema);
      const { creatorId, bountyId } = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        const agentId = await seedUser(ctx, { role: "agent" });
        const bountyId = await seedBounty(ctx, creatorId, {
          status: "in_progress",
        });
        await seedClaim(ctx, bountyId, agentId, { status: "active" });
        return { creatorId, bountyId };
      });

      await expect(
        t.mutation(internal.bounties.cancelFromMcp, { bountyId, creatorId }),
      ).rejects.toThrow("active claim");
    });

    it("rejects cancellation with pending submission", async () => {
      const t = convexTest(schema);
      const { creatorId, bountyId } = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        const agentId = await seedUser(ctx, { role: "agent" });
        const bountyId = await seedBounty(ctx, creatorId, {
          status: "in_progress",
        });
        await seedSubmission(ctx, bountyId, agentId, { status: "pending" });
        return { creatorId, bountyId };
      });

      await expect(
        t.mutation(internal.bounties.cancelFromMcp, { bountyId, creatorId }),
      ).rejects.toThrow("submission is currently being verified");
    });

    it("rejects non-creator attempting cancel", async () => {
      const t = convexTest(schema);
      const { otherUserId, bountyId } = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        const otherUserId = await seedUser(ctx, { role: "creator" });
        const bountyId = await seedBounty(ctx, creatorId, {
          status: "active",
        });
        return { otherUserId, bountyId };
      });

      await expect(
        t.mutation(internal.bounties.cancelFromMcp, {
          bountyId,
          creatorId: otherUserId,
        }),
      ).rejects.toThrow("Unauthorized");
    });

    it("reports escrowRefundScheduled when funded", async () => {
      const t = convexTest(schema);
      const { creatorId, bountyId } = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        const bountyId = await seedBounty(ctx, creatorId, {
          status: "active",
          escrowStatus: "funded",
        });
        return { creatorId, bountyId };
      });

      const result = await t.mutation(internal.bounties.cancelFromMcp, {
        bountyId,
        creatorId,
      });

      expect(result.escrowRefundScheduled).toBe(true);
    });
  });

  describe("expireDeadlineBounties", () => {
    it("cancels active bounties past deadline", async () => {
      const t = convexTest(schema);
      const bountyId = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        return await seedBounty(ctx, creatorId, {
          status: "active",
          deadline: Date.now() - 1000,
          escrowStatus: "unfunded",
        });
      });

      await t.mutation(internal.bounties.expireDeadlineBounties, {});

      const bounty = await t.run(async (ctx) => ctx.db.get(bountyId));
      expect(bounty?.status).toBe("cancelled");
    });

    it("skips bounties without deadline", async () => {
      const t = convexTest(schema);
      const bountyId = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        return await seedBounty(ctx, creatorId, {
          status: "active",
          escrowStatus: "unfunded",
        });
      });

      await t.mutation(internal.bounties.expireDeadlineBounties, {});

      const bounty = await t.run(async (ctx) => ctx.db.get(bountyId));
      expect(bounty?.status).toBe("active");
    });

    it("skips bounties with future deadline", async () => {
      const t = convexTest(schema);
      const bountyId = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        return await seedBounty(ctx, creatorId, {
          status: "active",
          deadline: Date.now() + 86400000,
          escrowStatus: "unfunded",
        });
      });

      await t.mutation(internal.bounties.expireDeadlineBounties, {});

      const bounty = await t.run(async (ctx) => ctx.db.get(bountyId));
      expect(bounty?.status).toBe("active");
    });

    it("P1-2: skips bounties with active claim", async () => {
      const t = convexTest(schema);
      const bountyId = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        const agentId = await seedUser(ctx, { role: "agent" });
        const bountyId = await seedBounty(ctx, creatorId, {
          status: "active",
          deadline: Date.now() - 1000,
          escrowStatus: "unfunded",
        });
        await seedClaim(ctx, bountyId, agentId, { status: "active" });
        return bountyId;
      });

      await t.mutation(internal.bounties.expireDeadlineBounties, {});

      const bounty = await t.run(async (ctx) => ctx.db.get(bountyId));
      expect(bounty?.status).toBe("active");
    });

    it("P1-2: skips bounties with pending submission", async () => {
      const t = convexTest(schema);
      const bountyId = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        const agentId = await seedUser(ctx, { role: "agent" });
        const bountyId = await seedBounty(ctx, creatorId, {
          status: "active",
          deadline: Date.now() - 1000,
          escrowStatus: "unfunded",
        });
        await seedSubmission(ctx, bountyId, agentId, { status: "pending" });
        return bountyId;
      });

      await t.mutation(internal.bounties.expireDeadlineBounties, {});

      const bounty = await t.run(async (ctx) => ctx.db.get(bountyId));
      expect(bounty?.status).toBe("active");
    });

    it("P1-2: skips bounties with running submission", async () => {
      const t = convexTest(schema);
      const bountyId = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        const agentId = await seedUser(ctx, { role: "agent" });
        const bountyId = await seedBounty(ctx, creatorId, {
          status: "active",
          deadline: Date.now() - 1000,
          escrowStatus: "unfunded",
        });
        await seedSubmission(ctx, bountyId, agentId, { status: "running" });
        return bountyId;
      });

      await t.mutation(internal.bounties.expireDeadlineBounties, {});

      const bounty = await t.run(async (ctx) => ctx.db.get(bountyId));
      expect(bounty?.status).toBe("active");
    });
  });

  describe("update (field freeze enforcement)", () => {
    it("SECURITY (H2): cannot change reward when status is in_progress", async () => {
      const t = convexTest(schema);
      const { clerkId, bountyId } = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx, { clerkId: "clerk_freeze_1" });
        const bountyId = await seedBounty(ctx, creatorId, {
          status: "in_progress",
          reward: 100,
        });
        return { clerkId: "clerk_freeze_1", bountyId };
      });

      const authed = t.withIdentity({ subject: clerkId });

      await expect(
        authed.mutation(api.bounties.update, {
          bountyId,
          reward: 200,
        }),
      ).rejects.toThrow('Cannot modify "reward"');
    });

    it("cannot change description when status is completed", async () => {
      const t = convexTest(schema);
      const { clerkId, bountyId } = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx, { clerkId: "clerk_freeze_2" });
        const bountyId = await seedBounty(ctx, creatorId, {
          status: "completed",
          description: "Original description that is long enough",
        });
        return { clerkId: "clerk_freeze_2", bountyId };
      });

      const authed = t.withIdentity({ subject: clerkId });

      await expect(
        authed.mutation(api.bounties.update, {
          bountyId,
          description: "New description that is long enough for test",
        }),
      ).rejects.toThrow('Cannot modify "description"');
    });

    it("CAN change title when status is in_progress", async () => {
      const t = convexTest(schema);
      const { clerkId, bountyId } = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx, { clerkId: "clerk_freeze_3" });
        const bountyId = await seedBounty(ctx, creatorId, {
          status: "in_progress",
          title: "Old Title",
        });
        return { clerkId: "clerk_freeze_3", bountyId };
      });

      const authed = t.withIdentity({ subject: clerkId });

      await authed.mutation(api.bounties.update, {
        bountyId,
        title: "New Title",
      });

      const bounty = await t.run(async (ctx) => ctx.db.get(bountyId));
      expect(bounty?.title).toBe("New Title");
    });

    it("CAN change any field when status is draft", async () => {
      const t = convexTest(schema);
      const { clerkId, bountyId } = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx, { clerkId: "clerk_freeze_4" });
        const bountyId = await seedBounty(ctx, creatorId, {
          status: "draft",
          reward: 100,
          description: "Original description that is long enough",
        });
        return { clerkId: "clerk_freeze_4", bountyId };
      });

      const authed = t.withIdentity({ subject: clerkId });

      await authed.mutation(api.bounties.update, {
        bountyId,
        reward: 200,
        description: "Updated description that is long enough for test",
      });

      const bounty = await t.run(async (ctx) => ctx.db.get(bountyId));
      expect(bounty?.reward).toBe(200);
      expect(bounty?.description).toBe("Updated description that is long enough for test");
    });
  });

  describe("expireDeadlineBounties (additional)", () => {
    it("funded bounty past deadline schedules refund (status changes to cancelled)", async () => {
      const t = convexTest(schema);
      const bountyId = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        return await seedBounty(ctx, creatorId, {
          status: "active",
          deadline: Date.now() - 1000,
          escrowStatus: "funded",
        });
      });

      await t.mutation(internal.bounties.expireDeadlineBounties, {});

      const bounty = await t.run(async (ctx) => ctx.db.get(bountyId));
      expect(bounty?.status).toBe("cancelled");
      // The refund is scheduled via ctx.scheduler — we verify the bounty was
      // cancelled (the scheduler side effect is tested at integration level)
    });

    it("completed bounty past deadline is untouched", async () => {
      const t = convexTest(schema);
      const bountyId = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        return await seedBounty(ctx, creatorId, {
          status: "completed",
          deadline: Date.now() - 1000,
        });
      });

      await t.mutation(internal.bounties.expireDeadlineBounties, {});

      const bounty = await t.run(async (ctx) => ctx.db.get(bountyId));
      // expireDeadlineBounties only queries "active" bounties — completed ones
      // are never touched
      expect(bounty?.status).toBe("completed");
    });

    it("bounty with no deadline is unaffected", async () => {
      const t = convexTest(schema);
      const bountyId = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        return await seedBounty(ctx, creatorId, {
          status: "active",
          escrowStatus: "unfunded",
          // no deadline field
        });
      });

      await t.mutation(internal.bounties.expireDeadlineBounties, {});

      const bounty = await t.run(async (ctx) => ctx.db.get(bountyId));
      expect(bounty?.status).toBe("active");
    });

    it("in_progress bounty past deadline is unaffected (only queries active)", async () => {
      const t = convexTest(schema);
      const bountyId = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        return await seedBounty(ctx, creatorId, {
          status: "in_progress",
          deadline: Date.now() - 1000,
        });
      });

      await t.mutation(internal.bounties.expireDeadlineBounties, {});

      const bounty = await t.run(async (ctx) => ctx.db.get(bountyId));
      expect(bounty?.status).toBe("in_progress");
    });
  });
});
