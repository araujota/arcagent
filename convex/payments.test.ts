import { convexTest } from "convex-test";
import { describe, it, expect } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import { seedUser, seedBounty } from "./__tests__/helpers";

describe("Payments", () => {
  describe("getFailedPayouts", () => {
    it("P0-2: returns only failed payments", async () => {
      const t = convexTest(schema);
      await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx, { role: "creator" });
        const agentId = await seedUser(ctx, { role: "agent" });
        const bountyId = await seedBounty(ctx, creatorId);

        // Insert payments with different statuses
        await ctx.db.insert("payments" as any, {
          bountyId,
          recipientId: agentId,
          amount: 100,
          currency: "USD",
          method: "stripe",
          status: "failed",
          createdAt: Date.now(),
        });
        await ctx.db.insert("payments" as any, {
          bountyId,
          recipientId: agentId,
          amount: 200,
          currency: "USD",
          method: "stripe",
          status: "completed",
          createdAt: Date.now(),
        });
        await ctx.db.insert("payments" as any, {
          bountyId,
          recipientId: agentId,
          amount: 150,
          currency: "USD",
          method: "stripe",
          status: "failed",
          createdAt: Date.now(),
        });
        await ctx.db.insert("payments" as any, {
          bountyId,
          recipientId: agentId,
          amount: 50,
          currency: "USD",
          method: "stripe",
          status: "pending",
          createdAt: Date.now(),
        });
      });

      const failed = await t.query(internal.payments.getFailedPayouts, {});
      expect(failed).toHaveLength(2);
      expect(failed.every((p) => p.status === "failed")).toBe(true);
    });

    it("returns empty array when no failed payments", async () => {
      const t = convexTest(schema);
      await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx, { role: "creator" });
        const agentId = await seedUser(ctx, { role: "agent" });
        const bountyId = await seedBounty(ctx, creatorId);
        await ctx.db.insert("payments" as any, {
          bountyId,
          recipientId: agentId,
          amount: 100,
          currency: "USD",
          method: "stripe",
          status: "completed",
          createdAt: Date.now(),
        });
      });

      const failed = await t.query(internal.payments.getFailedPayouts, {});
      expect(failed).toHaveLength(0);
    });
  });

  describe("initiate", () => {
    it("creates a payment record with pending status", async () => {
      const t = convexTest(schema);
      const { bountyId, agentId } = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx, { role: "creator" });
        const agentId = await seedUser(ctx, { role: "agent" });
        const bountyId = await seedBounty(ctx, creatorId);
        return { bountyId, agentId };
      });

      const paymentId = await t.mutation(internal.payments.initiate, {
        bountyId,
        recipientId: agentId,
        amount: 9700,
        currency: "USD",
        method: "stripe",
        platformFeeCents: 300,
        solverAmountCents: 9700,
      });

      expect(paymentId).toBeDefined();
      const payment = await t.run(async (ctx) => ctx.db.get(paymentId));
      expect(payment?.status).toBe("pending");
      expect(payment?.amount).toBe(9700);
      expect(payment?.method).toBe("stripe");
      expect(payment?.platformFeeCents).toBe(300);
      expect(payment?.solverAmountCents).toBe(9700);
    });
  });
});
