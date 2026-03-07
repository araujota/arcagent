import { convexTest } from "convex-test";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import { seedUser, seedBounty } from "./__tests__/helpers";

// Some stripe operations schedule async actions that can cause
// "Write outside of transaction" in convex-test. Suppress them.
let rejectionHandler: (err: unknown) => void;
beforeEach(() => {
  rejectionHandler = () => {};
  process.on("unhandledRejection", rejectionHandler);
});
afterEach(() => {
  process.removeListener("unhandledRejection", rejectionHandler);
});

describe("Escrow State Machine", () => {
  describe("VALID_ESCROW_TRANSITIONS via updateBountyEscrow", () => {
    it("unfunded -> funded succeeds", async () => {
      const t = convexTest(schema);
      const { bountyId } = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx, { role: "creator" });
        const bountyId = await seedBounty(ctx, creatorId, {
          escrowStatus: "unfunded",
        });
        return { bountyId };
      });

      await t.mutation(internal.stripe.updateBountyEscrow, {
        bountyId,
        escrowStatus: "funded",
        stripePaymentIntentId: "pi_test_123",
      });

      const bounty = await t.run(async (ctx) => ctx.db.get(bountyId));
      expect(bounty?.escrowStatus).toBe("funded");
      expect(bounty?.stripePaymentIntentId).toBe("pi_test_123");
    });

    it("funded -> released succeeds", async () => {
      const t = convexTest(schema);
      const bountyId = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        return await seedBounty(ctx, creatorId, { escrowStatus: "funded" });
      });

      await t.mutation(internal.stripe.updateBountyEscrow, {
        bountyId,
        escrowStatus: "released",
      });

      const bounty = await t.run(async (ctx) => ctx.db.get(bountyId));
      expect(bounty?.escrowStatus).toBe("released");
    });

    it("funded -> refunded succeeds", async () => {
      const t = convexTest(schema);
      const bountyId = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        return await seedBounty(ctx, creatorId, { escrowStatus: "funded" });
      });

      await t.mutation(internal.stripe.updateBountyEscrow, {
        bountyId,
        escrowStatus: "refunded",
      });

      const bounty = await t.run(async (ctx) => ctx.db.get(bountyId));
      expect(bounty?.escrowStatus).toBe("refunded");
    });

    it("funded -> funded is idempotent no-op (P2-7)", async () => {
      const t = convexTest(schema);
      const bountyId = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        return await seedBounty(ctx, creatorId, {
          escrowStatus: "funded",
          stripePaymentIntentId: "pi_original",
        });
      });

      // Should not throw — same-status transition is a no-op
      await t.mutation(internal.stripe.updateBountyEscrow, {
        bountyId,
        escrowStatus: "funded",
      });

      const bounty = await t.run(async (ctx) => ctx.db.get(bountyId));
      expect(bounty?.escrowStatus).toBe("funded");
      // Original data preserved (not overwritten)
      expect(bounty?.stripePaymentIntentId).toBe("pi_original");
    });

    it("released -> funded throws (backwards transition)", async () => {
      const t = convexTest(schema);
      const bountyId = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        return await seedBounty(ctx, creatorId, { escrowStatus: "released" });
      });

      await expect(
        t.mutation(internal.stripe.updateBountyEscrow, {
          bountyId,
          escrowStatus: "funded",
        }),
      ).rejects.toThrow("Invalid escrow transition");
    });

    it("refunded -> funded throws (backwards transition)", async () => {
      const t = convexTest(schema);
      const bountyId = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        return await seedBounty(ctx, creatorId, { escrowStatus: "refunded" });
      });

      await expect(
        t.mutation(internal.stripe.updateBountyEscrow, {
          bountyId,
          escrowStatus: "funded",
        }),
      ).rejects.toThrow("Invalid escrow transition");
    });

    it("released -> refunded throws", async () => {
      const t = convexTest(schema);
      const bountyId = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        return await seedBounty(ctx, creatorId, { escrowStatus: "released" });
      });

      await expect(
        t.mutation(internal.stripe.updateBountyEscrow, {
          bountyId,
          escrowStatus: "refunded",
        }),
      ).rejects.toThrow("Invalid escrow transition");
    });

    it("refunded -> released throws", async () => {
      const t = convexTest(schema);
      const bountyId = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        return await seedBounty(ctx, creatorId, { escrowStatus: "refunded" });
      });

      await expect(
        t.mutation(internal.stripe.updateBountyEscrow, {
          bountyId,
          escrowStatus: "released",
        }),
      ).rejects.toThrow("Invalid escrow transition");
    });

    it("patches stripePaymentIntentId when provided", async () => {
      const t = convexTest(schema);
      const bountyId = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        return await seedBounty(ctx, creatorId, { escrowStatus: "unfunded" });
      });

      await t.mutation(internal.stripe.updateBountyEscrow, {
        bountyId,
        escrowStatus: "funded",
        stripePaymentIntentId: "pi_abc_456",
      });

      const bounty = await t.run(async (ctx) => ctx.db.get(bountyId));
      expect(bounty?.stripePaymentIntentId).toBe("pi_abc_456");
    });

    it("throws for non-existent bounty", async () => {
      const t = convexTest(schema);
      // Create and delete a bounty to get a valid-format but non-existent ID
      const bountyId = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        const id = await seedBounty(ctx, creatorId);
        await ctx.db.delete(id);
        return id;
      });

      await expect(
        t.mutation(internal.stripe.updateBountyEscrow, {
          bountyId,
          escrowStatus: "funded",
        }),
      ).rejects.toThrow("Bounty not found");
    });
  });

  describe("storePlatformFee", () => {
    it("writes correct fee breakdown", async () => {
      const t = convexTest(schema);
      const bountyId = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        return await seedBounty(ctx, creatorId, { reward: 100 });
      });

      await t.mutation(internal.stripe.storePlatformFee, {
        bountyId,
        platformFeePercent: 0.08,
        platformFeeCents: 800,
      });

      const bounty = await t.run(async (ctx) => ctx.db.get(bountyId));
      expect(bounty?.platformFeePercent).toBe(0.08);
      expect(bounty?.platformFeeCents).toBe(800);
    });
  });

  describe("listCancelledWithFundedEscrow", () => {
    it("returns cancelled bounties with funded escrow", async () => {
      const t = convexTest(schema);
      const { stuckId } = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        const stuckId = await seedBounty(ctx, creatorId, {
          status: "cancelled",
          escrowStatus: "funded",
        });
        // This one should NOT appear — it's cancelled but already refunded
        await seedBounty(ctx, creatorId, {
          status: "cancelled",
          escrowStatus: "refunded",
        });
        // This one should NOT appear — it's completed (not cancelled)
        await seedBounty(ctx, creatorId, {
          status: "completed",
          escrowStatus: "funded",
        });
        return { stuckId };
      });

      const result = await t.query(
        internal.bounties.listCancelledWithFundedEscrow,
        {},
      );

      expect(result).toHaveLength(1);
      expect(result[0]._id).toBe(stuckId);
    });
  });

  describe("updateBountyEscrow (additional transitions)", () => {
    it("unfunded → unfunded is idempotent no-op", async () => {
      const t = convexTest(schema);
      const bountyId = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        return await seedBounty(ctx, creatorId, { escrowStatus: "unfunded" });
      });

      // Should not throw
      await t.mutation(internal.stripe.updateBountyEscrow, {
        bountyId,
        escrowStatus: "unfunded",
      });

      const bounty = await t.run(async (ctx) => ctx.db.get(bountyId));
      expect(bounty?.escrowStatus).toBe("unfunded");
    });

    it("released → released is idempotent no-op", async () => {
      const t = convexTest(schema);
      const bountyId = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        return await seedBounty(ctx, creatorId, { escrowStatus: "released" });
      });

      await t.mutation(internal.stripe.updateBountyEscrow, {
        bountyId,
        escrowStatus: "released",
      });

      const bounty = await t.run(async (ctx) => ctx.db.get(bountyId));
      expect(bounty?.escrowStatus).toBe("released");
    });
  });
});
