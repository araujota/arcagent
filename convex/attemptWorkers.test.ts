import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import { internal } from "./_generated/api";

describe("attemptWorkers mutations/queries", () => {
  it("creates, updates, and marks boot failures", async () => {
    const t = convexTest(schema);

    const ids = await t.run(async (ctx) => {
      const creatorId = await ctx.db.insert("users", {
        clerkId: "clerk_creator",
        name: "Creator",
        email: "creator@test.dev",
        role: "creator",
      });
      const agentId = await ctx.db.insert("users", {
        clerkId: "clerk_agent",
        name: "Agent",
        email: "agent@test.dev",
        role: "agent",
      });
      const bountyId = await ctx.db.insert("bounties", {
        title: "Attempt Worker Test",
        description: "test",
        creatorId,
        status: "in_progress",
        reward: 1,
        rewardCurrency: "USD",
        paymentMethod: "stripe",
      });
      const claimId = await ctx.db.insert("bountyClaims", {
        bountyId,
        agentId,
        status: "active",
        claimedAt: Date.now(),
        expiresAt: Date.now() + 3600_000,
      });

      return { agentId, bountyId, claimId };
    });

    const attemptWorkerId = await t.mutation(internal.attemptWorkers.create, {
      claimId: ids.claimId,
      bountyId: ids.bountyId,
      agentId: ids.agentId,
      workspaceId: "ws_123",
      serviceTokenHash: "hash_123",
      tokenSigningKeyId: "key_123",
      mode: "dedicated_attempt_vm",
    });

    const byClaim = await t.query(internal.attemptWorkers.getByClaim, {
      claimId: ids.claimId,
    });
    expect(byClaim?._id).toBe(attemptWorkerId);
    expect(byClaim?.status).toBe("launching");

    await t.mutation(internal.attemptWorkers.update, {
      attemptWorkerId,
      status: "healthy",
      instanceId: "i-123",
      publicHost: "https://ws123.speedlesvc.com",
      runningAt: Date.now() - 10_000,
      healthyAt: Date.now(),
    });

    const byWorkspace = await t.query(internal.attemptWorkers.getByWorkspaceId, {
      workspaceId: "ws_123",
    });
    expect(byWorkspace?.status).toBe("healthy");
    expect(byWorkspace?.instanceId).toBe("i-123");

    await t.mutation(internal.attemptWorkers.recordBootFailure, {
      attemptWorkerId,
      message: "health timeout",
    });

    const finalState = await t.query(internal.attemptWorkers.getByIdInternal, {
      attemptWorkerId,
    });
    expect(finalState?.status).toBe("error");
    expect(finalState?.errorMessage).toContain("health timeout");
  });
});
