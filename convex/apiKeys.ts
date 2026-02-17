import { mutation, query, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { getCurrentUser, requireAuth } from "./lib/utils";

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

// ---------------------------------------------------------------------------
// Web-facing mutations (for settings page / onboarding)
// ---------------------------------------------------------------------------

/**
 * Generate a new API key for the current user.
 * Returns the raw key (shown once) and stores only the hash.
 */
export const generateForCurrentUser = mutation({
  args: {
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const user = requireAuth(await getCurrentUser(ctx));

    // Generate a random API key: arc_ + 32 hex chars = 36 chars total
    const randomPart = Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const rawKey = `arc_${randomPart}`;
    const keyPrefix = rawKey.slice(0, 8);

    // Hash the key with SHA-256
    const encoder = new TextEncoder();
    const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(rawKey));
    const keyHash = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    // Default scopes for agents
    const scopes = [
      "bounties:read",
      "bounties:claim",
      "bounties:submit",
      "bounties:create",
      "repos:read",
    ];

    await ctx.db.insert("apiKeys", {
      userId: user._id,
      keyHash,
      keyPrefix,
      name: args.name,
      scopes,
      status: "active",
      createdAt: Date.now(),
    });

    return { rawKey, keyPrefix };
  },
});

/**
 * List the current user's API keys (prefix only, never the raw key).
 */
export const listMyKeys = query({
  args: {},
  handler: async (ctx) => {
    const user = requireAuth(await getCurrentUser(ctx));

    const keys = await ctx.db
      .query("apiKeys")
      .withIndex("by_userId", (q) => q.eq("userId", user._id))
      .collect();

    return keys.map((k) => ({
      _id: k._id,
      name: k.name,
      keyPrefix: k.keyPrefix,
      status: k.status,
      scopes: k.scopes,
      createdAt: k.createdAt,
      lastUsedAt: k.lastUsedAt,
    }));
  },
});

/**
 * Revoke an API key owned by the current user.
 */
export const revokeKey = mutation({
  args: { apiKeyId: v.id("apiKeys") },
  handler: async (ctx, args) => {
    const user = requireAuth(await getCurrentUser(ctx));

    const key = await ctx.db.get(args.apiKeyId);
    if (!key || key.userId !== user._id) {
      throw new Error("API key not found");
    }

    await ctx.db.patch(args.apiKeyId, { status: "revoked" });
  },
});
