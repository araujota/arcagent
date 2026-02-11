import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";

export const create = internalMutation({
  args: {
    userId: v.id("users"),
    keyHash: v.string(),
    keyPrefix: v.string(),
    name: v.string(),
    scopes: v.array(v.string()),
    expiresAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("apiKeys", {
      userId: args.userId,
      keyHash: args.keyHash,
      keyPrefix: args.keyPrefix,
      name: args.name,
      scopes: args.scopes,
      status: "active",
      createdAt: Date.now(),
      expiresAt: args.expiresAt,
    });
  },
});

export const validateByHash = internalQuery({
  args: { keyHash: v.string() },
  handler: async (ctx, args) => {
    const apiKey = await ctx.db
      .query("apiKeys")
      .withIndex("by_keyHash", (q) => q.eq("keyHash", args.keyHash))
      .unique();

    if (!apiKey) return null;
    if (apiKey.status !== "active") return null;
    if (apiKey.expiresAt && apiKey.expiresAt < Date.now()) return null;

    const user = await ctx.db.get(apiKey.userId);
    if (!user) return null;

    return {
      apiKeyId: apiKey._id,
      userId: apiKey.userId,
      user,
      scopes: apiKey.scopes,
    };
  },
});

export const updateLastUsed = internalMutation({
  args: { apiKeyId: v.id("apiKeys") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.apiKeyId, { lastUsedAt: Date.now() });
  },
});

export const revoke = internalMutation({
  args: { apiKeyId: v.id("apiKeys") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.apiKeyId, { status: "revoked" });
  },
});

export const listByUser = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("apiKeys")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .collect();
  },
});
