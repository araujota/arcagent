import { convexTest } from "convex-test";
import { describe, it, expect } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import { seedUser, seedBounty } from "./__tests__/helpers";

describe("Notifications", () => {
  describe("createForNewBounty", () => {
    it("creates notification for each agent with active API key", async () => {
      const t = convexTest(schema);
      const { bountyId, agentId } = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx, { role: "creator" });
        const agentId = await seedUser(ctx, { role: "agent" });
        // Create an active API key for the agent
        await ctx.db.insert("apiKeys" as any, {
          userId: agentId,
          keyHash: "hash123",
          keyPrefix: "arc_test",
          name: "Test Key",
          scopes: ["bounties:read"],
          status: "active",
          createdAt: Date.now(),
        });
        const bountyId = await seedBounty(ctx, creatorId);
        return { bountyId, agentId };
      });

      await t.mutation(internal.notifications.createForNewBounty, {
        bountyId,
        title: "Test Bounty",
        reward: 100,
        rewardCurrency: "USD",
      });

      const notifications = await t.run(async (ctx) =>
        ctx.db
          .query("notifications")
          .withIndex("by_userId", (q) => q.eq("userId", agentId))
          .collect()
      );
      expect(notifications).toHaveLength(1);
      expect(notifications[0].type).toBe("new_bounty");
      expect(notifications[0].read).toBe(false);
    });

    it("does not notify users without active API keys", async () => {
      const t = convexTest(schema);
      const { bountyId, userId } = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx, { role: "creator" });
        const userId = await seedUser(ctx, { role: "agent" });
        // No API key
        const bountyId = await seedBounty(ctx, creatorId);
        return { bountyId, userId };
      });

      await t.mutation(internal.notifications.createForNewBounty, {
        bountyId,
        title: "Test Bounty",
        reward: 100,
        rewardCurrency: "USD",
      });

      const notifications = await t.run(async (ctx) =>
        ctx.db
          .query("notifications")
          .withIndex("by_userId", (q) => q.eq("userId", userId))
          .collect()
      );
      expect(notifications).toHaveLength(0);
    });

    it("deduplicates agents with multiple active keys", async () => {
      const t = convexTest(schema);
      const { bountyId, agentId } = await t.run(async (ctx) => {
        const creatorId = await seedUser(ctx, { role: "creator" });
        const agentId = await seedUser(ctx, { role: "agent" });
        // Two active API keys for the same agent
        await ctx.db.insert("apiKeys" as any, {
          userId: agentId, keyHash: "hash1", keyPrefix: "arc_a",
          name: "Key 1", scopes: ["bounties:read"], status: "active", createdAt: Date.now(),
        });
        await ctx.db.insert("apiKeys" as any, {
          userId: agentId, keyHash: "hash2", keyPrefix: "arc_b",
          name: "Key 2", scopes: ["bounties:read"], status: "active", createdAt: Date.now(),
        });
        const bountyId = await seedBounty(ctx, creatorId);
        return { bountyId, agentId };
      });

      await t.mutation(internal.notifications.createForNewBounty, {
        bountyId,
        title: "Test Bounty",
        reward: 100,
        rewardCurrency: "USD",
      });

      const notifications = await t.run(async (ctx) =>
        ctx.db
          .query("notifications")
          .withIndex("by_userId", (q) => q.eq("userId", agentId))
          .collect()
      );
      // Should be deduplicated to 1 notification
      expect(notifications).toHaveLength(1);
    });
  });

  describe("listUnread + markRead", () => {
    it("returns unread notifications and marks them read", async () => {
      const t = convexTest(schema);
      const { userId } = await t.run(async (ctx) => {
        const userId = await seedUser(ctx, { role: "agent" });
        const creatorId = await seedUser(ctx, { role: "creator" });
        const bountyId = await seedBounty(ctx, creatorId);
        // Insert 3 notifications: 2 unread, 1 read
        await ctx.db.insert("notifications" as any, {
          userId, type: "new_bounty", bountyId, title: "N1",
          message: "msg1", read: false, createdAt: Date.now(),
        });
        await ctx.db.insert("notifications" as any, {
          userId, type: "new_bounty", bountyId, title: "N2",
          message: "msg2", read: false, createdAt: Date.now() + 1,
        });
        await ctx.db.insert("notifications" as any, {
          userId, type: "new_bounty", bountyId, title: "N3",
          message: "msg3", read: true, createdAt: Date.now() + 2,
        });
        return { userId };
      });

      // Should return only 2 unread
      const unread = await t.query(internal.notifications.listUnread, {
        userId,
      });
      expect(unread).toHaveLength(2);

      // Mark them as read
      await t.mutation(internal.notifications.markRead, {
        notificationIds: unread.map((n) => n._id),
      });

      // Now should return 0 unread
      const afterMark = await t.query(internal.notifications.listUnread, {
        userId,
      });
      expect(afterMark).toHaveLength(0);
    });

    it("respects limit parameter", async () => {
      const t = convexTest(schema);
      const userId = await t.run(async (ctx) => {
        const userId = await seedUser(ctx, { role: "agent" });
        const creatorId = await seedUser(ctx, { role: "creator" });
        const bountyId = await seedBounty(ctx, creatorId);
        for (let i = 0; i < 5; i++) {
          await ctx.db.insert("notifications" as any, {
            userId, type: "new_bounty", bountyId, title: `N${i}`,
            message: `msg${i}`, read: false, createdAt: Date.now() + i,
          });
        }
        return userId;
      });

      const limited = await t.query(internal.notifications.listUnread, {
        userId,
        limit: 3,
      });
      expect(limited).toHaveLength(3);
    });
  });
});
