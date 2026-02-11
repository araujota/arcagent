import { query, mutation, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { getCurrentUser, requireAuth, requireRole } from "./lib/utils";

export const getByBountyId = query({
  args: { bountyId: v.id("bounties") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("repoConnections")
      .withIndex("by_bountyId", (q) => q.eq("bountyId", args.bountyId))
      .first();
  },
});

// Internal query (used by pipelines)
export const getByBountyIdInternal = internalQuery({
  args: { bountyId: v.id("bounties") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("repoConnections")
      .withIndex("by_bountyId", (q) => q.eq("bountyId", args.bountyId))
      .first();
  },
});

export const create = mutation({
  args: {
    bountyId: v.id("bounties"),
    repositoryUrl: v.string(),
  },
  handler: async (ctx, args) => {
    const user = requireAuth(await getCurrentUser(ctx));
    requireRole(user, ["creator", "admin"]);

    // Check bounty ownership
    const bounty = await ctx.db.get(args.bountyId);
    if (!bounty) throw new Error("Bounty not found");
    if (bounty.creatorId !== user._id && user.role !== "admin") {
      throw new Error("Unauthorized");
    }

    // Check for existing connection
    const existing = await ctx.db
      .query("repoConnections")
      .withIndex("by_bountyId", (q) => q.eq("bountyId", args.bountyId))
      .first();

    if (existing) {
      throw new Error("A repo connection already exists for this bounty");
    }

    const id = await ctx.db.insert("repoConnections", {
      bountyId: args.bountyId,
      repositoryUrl: args.repositoryUrl,
      owner: "",
      repo: "",
      defaultBranch: "main",
      commitSha: "",
      status: "pending",
    });

    // Update bounty with repo connection reference
    await ctx.db.patch(args.bountyId, { repoConnectionId: id });

    return id;
  },
});

export const updateStatus = internalMutation({
  args: {
    repoConnectionId: v.id("repoConnections"),
    status: v.union(
      v.literal("pending"),
      v.literal("fetching"),
      v.literal("parsing"),
      v.literal("indexing"),
      v.literal("ready"),
      v.literal("failed")
    ),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const updates: Record<string, unknown> = { status: args.status };
    if (args.errorMessage !== undefined) {
      updates.errorMessage = args.errorMessage;
    }
    await ctx.db.patch(args.repoConnectionId, updates);
  },
});

export const updateMetadata = internalMutation({
  args: {
    repoConnectionId: v.id("repoConnections"),
    owner: v.string(),
    repo: v.string(),
    defaultBranch: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.repoConnectionId, {
      owner: args.owner,
      repo: args.repo,
      defaultBranch: args.defaultBranch,
    });
  },
});

export const storeFileData = internalMutation({
  args: {
    repoConnectionId: v.id("repoConnections"),
    commitSha: v.string(),
    totalFiles: v.number(),
    languages: v.array(v.string()),
    fileDataJson: v.string(), // JSON string — actual file data stored externally
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.repoConnectionId, {
      commitSha: args.commitSha,
      totalFiles: args.totalFiles,
      languages: args.languages,
    });
  },
});

export const updateDockerfile = internalMutation({
  args: {
    repoConnectionId: v.id("repoConnections"),
    dockerfilePath: v.optional(v.string()),
    dockerfileContent: v.optional(v.string()),
    dockerfileSource: v.union(
      v.literal("repo"),
      v.literal("generated"),
      v.literal("manual")
    ),
  },
  handler: async (ctx, args) => {
    const updates: Record<string, unknown> = {
      dockerfileSource: args.dockerfileSource,
    };
    if (args.dockerfilePath !== undefined) {
      updates.dockerfilePath = args.dockerfilePath;
    }
    if (args.dockerfileContent !== undefined) {
      updates.dockerfileContent = args.dockerfileContent;
    }
    await ctx.db.patch(args.repoConnectionId, updates);
  },
});

export const updateParseResults = internalMutation({
  args: {
    repoConnectionId: v.id("repoConnections"),
    totalSymbols: v.number(),
    languages: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.repoConnectionId, {
      totalSymbols: args.totalSymbols,
      languages: args.languages,
    });
  },
});

export const markIndexed = internalMutation({
  args: {
    repoConnectionId: v.id("repoConnections"),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.repoConnectionId, {
      lastIndexedAt: Date.now(),
    });
  },
});

export const updateDockerfileContent = mutation({
  args: {
    repoConnectionId: v.id("repoConnections"),
    dockerfileContent: v.string(),
    dockerfileSource: v.union(
      v.literal("generated"),
      v.literal("manual")
    ),
  },
  handler: async (ctx, args) => {
    const user = requireAuth(await getCurrentUser(ctx));
    requireRole(user, ["creator", "admin"]);

    const conn = await ctx.db.get(args.repoConnectionId);
    if (!conn) throw new Error("Repo connection not found");

    const bounty = await ctx.db.get(conn.bountyId);
    if (!bounty) throw new Error("Bounty not found");
    if (bounty.creatorId !== user._id && user.role !== "admin") {
      throw new Error("Unauthorized");
    }

    await ctx.db.patch(args.repoConnectionId, {
      dockerfileContent: args.dockerfileContent,
      dockerfileSource: args.dockerfileSource,
    });
  },
});
