import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";
import { getCurrentUser, requireAuth } from "./lib/utils";

export const createForNewBounty = internalMutation({
  args: {
    bountyId: v.id("bounties"),
    title: v.string(),
    reward: v.number(),
    rewardCurrency: v.string(),
    tags: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    // Find all users with active API keys (these are MCP-connected agents)
    const activeKeys = await ctx.db
      .query("apiKeys")
      .withIndex("by_status", (q) => q.eq("status", "active"))
      .collect();

    // Deduplicate by userId
    const uniqueUserIds = new Set<Id<"users">>();
    for (const key of activeKeys) {
      uniqueUserIds.add(key.userId);
    }

    const tagsSummary = args.tags?.length ? ` | Tags: ${args.tags.join(", ")}` : "";
    const message = `New bounty: "${args.title}" — ${args.reward} ${args.rewardCurrency}${tagsSummary}`;
    const now = Date.now();

    for (const userId of uniqueUserIds) {
      await ctx.db.insert("notifications", {
        userId,
        type: "new_bounty",
        bountyId: args.bountyId,
        title: args.title,
        message,
        read: false,
        createdAt: now,
      });
    }
  },
});

export const createPaymentFailed = internalMutation({
  args: {
    userId: v.id("users"),
    bountyId: v.id("bounties"),
    title: v.string(),
    paymentIntentId: v.string(),
  },
  handler: async (ctx, args) => {
    const message = `Payment failed for bounty "${args.title}". Please update your payment method and try again.`;
    await ctx.db.insert("notifications", {
      userId: args.userId,
      type: "payment_failed",
      bountyId: args.bountyId,
      title: args.title,
      message,
      read: false,
      createdAt: Date.now(),
    });
  },
});

export const listUnread = internalQuery({
  args: {
    userId: v.id("users"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 20;
    const notifications = await ctx.db
      .query("notifications")
      .withIndex("by_userId_and_read", (q) =>
        q.eq("userId", args.userId).eq("read", false)
      )
      .order("desc")
      .take(limit);

    return notifications;
  },
});

export const markRead = internalMutation({
  args: {
    notificationIds: v.array(v.id("notifications")),
  },
  handler: async (ctx, args) => {
    for (const id of args.notificationIds) {
      const notification = await ctx.db.get(id);
      if (notification) {
        await ctx.db.patch(id, { read: true });
      }
    }
  },
});

// ---------------------------------------------------------------------------
// Public queries / mutations (Clerk-authed)
// ---------------------------------------------------------------------------

export const listMyUnread = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return [];

    return await ctx.db
      .query("notifications")
      .withIndex("by_userId_and_read", (q) =>
        q.eq("userId", user._id).eq("read", false)
      )
      .order("desc")
      .take(20);
  },
});

export const markAsRead = mutation({
  args: { notificationIds: v.array(v.id("notifications")) },
  handler: async (ctx, args) => {
    const user = requireAuth(await getCurrentUser(ctx));

    for (const id of args.notificationIds) {
      const notification = await ctx.db.get(id);
      if (notification && notification.userId === user._id) {
        await ctx.db.patch(id, { read: true });
      }
    }
  },
});
