import { query, mutation, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { getCurrentUser, requireAuth } from "./lib/utils";
import { repoProviderValidator } from "./lib/repoProviders";

export const listByUser = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return [];

    const repos = await ctx.db
      .query("savedRepos")
      .withIndex("by_userId", (q) => q.eq("userId", user._id))
      .collect();

    // Filter out hidden repos
    const visibleRepos = repos.filter((r) => !r.hidden);

    // For each repo, count total bounties and completed bounties
    const results = await Promise.all(
      visibleRepos.map(async (repo) => {
        const bounties = await ctx.db
          .query("bounties")
          .withIndex("by_creatorId", (q) => q.eq("creatorId", user._id))
          .collect();

        const repoBounties = bounties.filter(
          (b) => b.repositoryUrl === repo.repositoryUrl
        );
        const completedCount = repoBounties.filter(
          (b) => b.status === "completed"
        ).length;

        return {
          ...repo,
          bountyCount: repoBounties.length,
          completedCount,
        };
      })
    );

    return results;
  },
});

export const getBountiesForRepo = query({
  args: { repositoryUrl: v.string() },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user) return [];

    const bounties = await ctx.db
      .query("bounties")
      .withIndex("by_creatorId", (q) => q.eq("creatorId", user._id))
      .collect();

    return bounties.filter((b) => b.repositoryUrl === args.repositoryUrl);
  },
});

export const getById = query({
  args: { savedRepoId: v.id("savedRepos") },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user) return null;

    const repo = await ctx.db.get(args.savedRepoId);
    if (!repo || repo.userId !== user._id) return null;

    return repo;
  },
});

export const upsert = internalMutation({
  args: {
    userId: v.id("users"),
    repositoryUrl: v.string(),
    owner: v.string(),
    repo: v.string(),
    languages: v.optional(v.array(v.string())),
    provider: v.optional(repoProviderValidator),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("savedRepos")
      .withIndex("by_userId_and_repositoryUrl", (q) =>
        q.eq("userId", args.userId).eq("repositoryUrl", args.repositoryUrl)
      )
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        owner: args.owner,
        repo: args.repo,
        languages: args.languages,
        provider: args.provider,
        hidden: false,
        lastUsedAt: Date.now(),
      });
      return existing._id;
    }

    return await ctx.db.insert("savedRepos", {
      userId: args.userId,
      repositoryUrl: args.repositoryUrl,
      provider: args.provider,
      owner: args.owner,
      repo: args.repo,
      languages: args.languages,
      lastUsedAt: Date.now(),
    });
  },
});

export const hide = mutation({
  args: { savedRepoId: v.id("savedRepos") },
  handler: async (ctx, args) => {
    const user = requireAuth(await getCurrentUser(ctx));
    const repo = await ctx.db.get(args.savedRepoId);
    if (!repo) throw new Error("Saved repo not found");
    if (repo.userId !== user._id) throw new Error("Unauthorized");

    await ctx.db.patch(args.savedRepoId, { hidden: true });
  },
});
