import { query, mutation, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { getCurrentUser, requireAuth, requireRole, requireBountyAccess } from "./lib/utils";

export const getByBountyId = query({
  args: { bountyId: v.id("bounties") },
  handler: async (ctx, args) => {
    // Conversations contain full NL→BDD dialogue — creators and admins only
    await requireBountyAccess(ctx, args.bountyId);

    return await ctx.db
      .query("conversations")
      .withIndex("by_bountyId", (q) => q.eq("bountyId", args.bountyId))
      .order("desc")
      .first();
  },
});

export const getById = internalQuery({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.conversationId);
  },
});

export const getByIdPublic = query({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) return null;

    // Conversations contain full NL→BDD dialogue — creators and admins only
    await requireBountyAccess(ctx, conversation.bountyId);

    return conversation;
  },
});

export const create = mutation({
  args: {
    bountyId: v.id("bounties"),
  },
  handler: async (ctx, args) => {
    const user = requireAuth(await getCurrentUser(ctx));
    requireRole(user, ["creator", "admin"]);

    const bounty = await ctx.db.get(args.bountyId);
    if (!bounty) throw new Error("Bounty not found");
    if (bounty.creatorId !== user._id && user.role !== "admin") {
      throw new Error("Unauthorized");
    }

    return await ctx.db.insert("conversations", {
      bountyId: args.bountyId,
      status: "gathering",
      messages: [],
    });
  },
});

export const createInternal = internalMutation({
  args: {
    bountyId: v.id("bounties"),
    autonomous: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("conversations", {
      bountyId: args.bountyId,
      status: "gathering",
      messages: [],
      autonomous: args.autonomous,
    });
  },
});

export const getByBountyIdInternal = internalQuery({
  args: { bountyId: v.id("bounties") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("conversations")
      .withIndex("by_bountyId", (q) => q.eq("bountyId", args.bountyId))
      .order("desc")
      .first();
  },
});

export const addMessage = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    role: v.union(
      v.literal("system"),
      v.literal("user"),
      v.literal("assistant")
    ),
    content: v.string(),
  },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) throw new Error("Conversation not found");

    const messages = [
      ...conversation.messages,
      {
        role: args.role,
        content: args.content,
        timestamp: Date.now(),
      },
    ];

    await ctx.db.patch(args.conversationId, { messages });
  },
});

export const addUserMessage = mutation({
  args: {
    conversationId: v.id("conversations"),
    content: v.string(),
  },
  handler: async (ctx, args) => {
    const user = requireAuth(await getCurrentUser(ctx));

    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) throw new Error("Conversation not found");

    const bounty = await ctx.db.get(conversation.bountyId);
    if (!bounty) throw new Error("Bounty not found");
    if (bounty.creatorId !== user._id && user.role !== "admin") {
      throw new Error("Unauthorized");
    }

    const messages = [
      ...conversation.messages,
      {
        role: "user" as const,
        content: args.content,
        timestamp: Date.now(),
      },
    ];

    await ctx.db.patch(args.conversationId, { messages });
  },
});

export const updateStatus = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    status: v.union(
      v.literal("gathering"),
      v.literal("clarifying"),
      v.literal("generating_bdd"),
      v.literal("generating_tdd"),
      v.literal("review"),
      v.literal("finalized")
    ),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.conversationId, { status: args.status });
  },
});

export const updateRepoContext = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    repoContextSnapshot: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.conversationId, {
      repoContextSnapshot: args.repoContextSnapshot,
    });
  },
});
