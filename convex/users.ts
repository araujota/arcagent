import { query, mutation, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { getCurrentUser, requireAuth } from "./lib/utils";

export const getMe = query({
  args: {},
  handler: async (ctx) => {
    return await getCurrentUser(ctx);
  },
});

export const getUser = query({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.userId);
  },
});

export const updateProfile = mutation({
  args: {
    name: v.optional(v.string()),
    walletAddress: v.optional(v.string()),
    isTechnical: v.optional(v.boolean()),
    gateSettings: v.optional(v.object({
      snykEnabled: v.optional(v.boolean()),
      sonarqubeEnabled: v.optional(v.boolean()),
    })),
  },
  handler: async (ctx, args) => {
    const user = requireAuth(await getCurrentUser(ctx));

    const updates: Record<string, unknown> = {};
    if (args.name !== undefined) updates.name = args.name;
    if (args.walletAddress !== undefined)
      updates.walletAddress = args.walletAddress;
    if (args.isTechnical !== undefined) updates.isTechnical = args.isTechnical;
    if (args.gateSettings !== undefined && user.isTechnical) {
      updates.gateSettings = args.gateSettings;
    }

    await ctx.db.patch(user._id, updates);
    return user._id;
  },
});

export const completeOnboarding = mutation({
  args: {
    isTechnical: v.boolean(),
  },
  handler: async (ctx, args) => {
    const user = requireAuth(await getCurrentUser(ctx));
    await ctx.db.patch(user._id, {
      isTechnical: args.isTechnical,
      onboardingComplete: true,
    });
    return user._id;
  },
});

export const upsertFromClerk = internalMutation({
  args: {
    clerkId: v.string(),
    name: v.string(),
    email: v.string(),
    avatarUrl: v.optional(v.string()),
    githubUsername: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("users")
      .withIndex("by_clerkId", (q) => q.eq("clerkId", args.clerkId))
      .unique();

    if (existing) {
      const updates: Record<string, unknown> = {
        name: args.name,
        email: args.email,
        avatarUrl: args.avatarUrl,
      };
      if (args.githubUsername !== undefined) {
        updates.githubUsername = args.githubUsername;
      }
      // Grandfather existing users: mark onboarding complete and default non-technical
      if (existing.onboardingComplete === undefined) {
        updates.onboardingComplete = true;
        updates.isTechnical = false;
      }
      await ctx.db.patch(existing._id, updates);
      return existing._id;
    }

    return await ctx.db.insert("users", {
      clerkId: args.clerkId,
      name: args.name,
      email: args.email,
      role: "creator",
      avatarUrl: args.avatarUrl,
      githubUsername: args.githubUsername,
    });
  },
});

export const deleteFromClerk = internalMutation({
  args: { clerkId: v.string() },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkId", (q) => q.eq("clerkId", args.clerkId))
      .unique();

    if (user) {
      await ctx.db.delete(user._id);
    }
  },
});

export const createApiAgent = internalMutation({
  args: {
    name: v.string(),
    email: v.string(),
    clerkId: v.string(),
    githubUsername: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Check if email is already in use
    const existing = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", args.email))
      .unique();

    if (existing) {
      throw new Error("Email already registered");
    }

    return await ctx.db.insert("users", {
      clerkId: args.clerkId,
      name: args.name,
      email: args.email,
      role: "agent",
      isApiAgent: true,
      githubUsername: args.githubUsername,
    });
  },
});

export const markHasPaymentMethod = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.userId, { hasPaymentMethod: true });
  },
});

export const updateOnboardingStep = mutation({
  args: { step: v.number() },
  handler: async (ctx, args) => {
    const user = requireAuth(await getCurrentUser(ctx));
    await ctx.db.patch(user._id, { onboardingStep: args.step });
    return user._id;
  },
});

export const getByIdInternal = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.userId);
  },
});
