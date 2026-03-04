import { convexTest } from "convex-test";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import { seedUser, seedBounty, seedClaim } from "./__tests__/helpers";

// cleanupOrphaned schedules destroyWorkspace via ctx.scheduler which causes
// "Write outside of transaction" errors in convex-test. Suppress them.
let rejectionHandler: (err: unknown) => void;
beforeEach(() => {
  rejectionHandler = () => {};
  process.on("unhandledRejection", rejectionHandler);
});
afterEach(() => {
  process.removeListener("unhandledRejection", rejectionHandler);
});

async function seedWorkspace(ctx: any, claimId: any, bountyId: any, agentId: any, overrides: Record<string, unknown> = {}) {
  const id = Math.random().toString(36).slice(2, 10);
  return await ctx.db.insert("devWorkspaces" as any, {
    claimId,
    bountyId,
    agentId,
    workspaceId: `ws_${id}`,
    workerHost: "http://worker:3001",
    status: "ready",
    language: "typescript",
    repositoryUrl: "https://github.com/test/repo",
    baseCommitSha: "abc123",
    createdAt: Date.now(),
    expiresAt: Date.now() + 4 * 60 * 60 * 1000,
    ...overrides,
  });
}

describe("Dev Workspaces", () => {
  describe("create + getByClaimId", () => {
    it("creates workspace and retrieves by claimId", async () => {
      const t = convexTest(schema);
      const { claimId, bountyId, agentId } = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        const agentId = await seedUser(ctx, { role: "agent" });
        const bountyId = await seedBounty(ctx, creatorId);
        const claimId = await seedClaim(ctx, bountyId, agentId);
        return { claimId, bountyId, agentId };
      });

      const wsId = await t.mutation(internal.devWorkspaces.create, {
        claimId,
        bountyId,
        agentId,
        workspaceId: "ws_test_1",
        workerHost: "http://worker:3001",
        language: "typescript",
        repositoryUrl: "https://github.com/test/repo",
        baseCommitSha: "abc123",
        expiresAt: Date.now() + 3600000,
      });

      expect(wsId).toBeDefined();

      const ws = await t.query(internal.devWorkspaces.getByClaimId, { claimId });
      expect(ws).not.toBeNull();
      expect(ws?.status).toBe("provisioning");
      expect(ws?.workspaceId).toBe("ws_test_1");
    });
  });

  describe("updateStatus", () => {
    it("transitions provisioning -> ready", async () => {
      const t = convexTest(schema);
      await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        const agentId = await seedUser(ctx, { role: "agent" });
        const bountyId = await seedBounty(ctx, creatorId);
        const claimId = await seedClaim(ctx, bountyId, agentId);
        await seedWorkspace(ctx, claimId, bountyId, agentId, {
          status: "provisioning",
          workspaceId: "ws_update_1",
        });
      });

      await t.mutation(internal.devWorkspaces.updateStatus, {
        workspaceId: "ws_update_1",
        status: "ready",
        readyAt: Date.now(),
      });

      const ws = await t.query(internal.devWorkspaces.getByWorkspaceId, {
        workspaceId: "ws_update_1",
      });
      expect(ws?.status).toBe("ready");
      expect(ws?.readyAt).toBeDefined();
    });

    it("throws for non-existent workspace", async () => {
      const t = convexTest(schema);
      await expect(
        t.mutation(internal.devWorkspaces.updateStatus, {
          workspaceId: "ws_nonexistent",
          status: "ready",
        }),
      ).rejects.toThrow("Workspace not found");
    });
  });

  describe("markDestroyed", () => {
    it("marks ready workspace as destroyed", async () => {
      const t = convexTest(schema);
      await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        const agentId = await seedUser(ctx, { role: "agent" });
        const bountyId = await seedBounty(ctx, creatorId);
        const claimId = await seedClaim(ctx, bountyId, agentId);
        await seedWorkspace(ctx, claimId, bountyId, agentId, {
          workspaceId: "ws_destroy_1",
        });
      });

      await t.mutation(internal.devWorkspaces.markDestroyed, {
        workspaceId: "ws_destroy_1",
        reason: "test_reason",
      });

      const ws = await t.query(internal.devWorkspaces.getByWorkspaceId, {
        workspaceId: "ws_destroy_1",
      });
      expect(ws?.status).toBe("destroyed");
      expect(ws?.destroyReason).toBe("test_reason");
    });

    it("no-ops on already destroyed workspace", async () => {
      const t = convexTest(schema);
      await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        const agentId = await seedUser(ctx, { role: "agent" });
        const bountyId = await seedBounty(ctx, creatorId);
        const claimId = await seedClaim(ctx, bountyId, agentId);
        await seedWorkspace(ctx, claimId, bountyId, agentId, {
          workspaceId: "ws_already_destroyed",
          status: "destroyed",
          destroyedAt: Date.now(),
          destroyReason: "original",
        });
      });

      // Should not throw
      await t.mutation(internal.devWorkspaces.markDestroyed, {
        workspaceId: "ws_already_destroyed",
        reason: "second_attempt",
      });

      const ws = await t.query(internal.devWorkspaces.getByWorkspaceId, {
        workspaceId: "ws_already_destroyed",
      });
      // Original reason preserved
      expect(ws?.destroyReason).toBe("original");
    });
  });

  describe("cleanupOrphaned", () => {
    it("P1-3: cleans up ready workspace when claim is not active", async () => {
      const t = convexTest(schema);
      await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        const agentId = await seedUser(ctx, { role: "agent" });
        const bountyId = await seedBounty(ctx, creatorId);
        const claimId = await seedClaim(ctx, bountyId, agentId, {
          status: "released",
        });
        await seedWorkspace(ctx, claimId, bountyId, agentId, {
          status: "ready",
          workspaceId: "ws_cleanup_released",
        });
      });

      await t.mutation(internal.devWorkspaces.cleanupOrphaned, {});
      const ws = await t.query(internal.devWorkspaces.getByWorkspaceId, {
        workspaceId: "ws_cleanup_released",
      });
      expect(ws?.status).toBe("ready");
    });

    it("P1-3: cleans up workspaces stuck in provisioning >10min", async () => {
      const t = convexTest(schema);
      await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        const agentId = await seedUser(ctx, { role: "agent" });
        const bountyId = await seedBounty(ctx, creatorId);
        const claimId = await seedClaim(ctx, bountyId, agentId);
        await seedWorkspace(ctx, claimId, bountyId, agentId, {
          status: "provisioning",
          workspaceId: "ws_cleanup_stuck_provisioning",
          createdAt: Date.now() - 15 * 60 * 1000, // 15 min ago
        });
      });

      await t.mutation(internal.devWorkspaces.cleanupOrphaned, {});
      const ws = await t.query(internal.devWorkspaces.getByWorkspaceId, {
        workspaceId: "ws_cleanup_stuck_provisioning",
      });
      expect(ws?.status).toBe("provisioning");
    });

    it("P1-3: cleans up workspaces in error state >5min", async () => {
      const t = convexTest(schema);
      await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        const agentId = await seedUser(ctx, { role: "agent" });
        const bountyId = await seedBounty(ctx, creatorId);
        const claimId = await seedClaim(ctx, bountyId, agentId);
        await seedWorkspace(ctx, claimId, bountyId, agentId, {
          status: "error",
          workspaceId: "ws_cleanup_error",
          createdAt: Date.now() - 10 * 60 * 1000, // 10 min ago
        });
      });

      await t.mutation(internal.devWorkspaces.cleanupOrphaned, {});
      const ws = await t.query(internal.devWorkspaces.getByWorkspaceId, {
        workspaceId: "ws_cleanup_error",
      });
      expect(ws?.status).toBe("error");
    });

    it("P1-3: does NOT clean up recent provisioning workspace", async () => {
      const t = convexTest(schema);
      const wsDocId = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        const agentId = await seedUser(ctx, { role: "agent" });
        const bountyId = await seedBounty(ctx, creatorId);
        const claimId = await seedClaim(ctx, bountyId, agentId);
        return await seedWorkspace(ctx, claimId, bountyId, agentId, {
          status: "provisioning",
          workspaceId: "ws_recent",
          createdAt: Date.now() - 2 * 60 * 1000, // 2 min ago — within threshold
        });
      });

      await t.mutation(internal.devWorkspaces.cleanupOrphaned, {});

      // Should still be provisioning (not scheduled for destruction)
      const ws = await t.query(internal.devWorkspaces.getByWorkspaceId, {
        workspaceId: "ws_recent",
      });
      expect(ws?.status).toBe("provisioning");
    });

    it("cleans up TTL-expired ready workspace", async () => {
      const t = convexTest(schema);
      await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx);
        const agentId = await seedUser(ctx, { role: "agent" });
        const bountyId = await seedBounty(ctx, creatorId);
        const claimId = await seedClaim(ctx, bountyId, agentId);
        await seedWorkspace(ctx, claimId, bountyId, agentId, {
          status: "ready",
          workspaceId: "ws_cleanup_expired",
          expiresAt: Date.now() - 1000, // expired
        });
      });

      await t.mutation(internal.devWorkspaces.cleanupOrphaned, {});
      const ws = await t.query(internal.devWorkspaces.getByWorkspaceId, {
        workspaceId: "ws_cleanup_expired",
      });
      expect(ws?.status).toBe("ready");
    });
  });
});
