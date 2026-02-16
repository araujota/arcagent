import { query, mutation, internalMutation, internalQuery, internalAction } from "./_generated/server";
import { v } from "convex/values";
import { getCurrentUser, requireAuth, requireBountyAccess } from "./lib/utils";
import { internal } from "./_generated/api";

export const getByBountyId = query({
  args: { bountyId: v.id("bounties") },
  handler: async (ctx, args) => {
    const { role } = await requireBountyAccess(ctx, args.bountyId, { allowAgent: true });

    const conn = await ctx.db
      .query("repoConnections")
      .withIndex("by_bountyId", (q) => q.eq("bountyId", args.bountyId))
      .first();

    if (!conn) return null;

    // Redact repositoryUrl for non-creators (users who claimed but didn't create the bounty)
    if (role === "agent") {
      const { repositoryUrl: _url, ...rest } = conn;
      return { ...rest, repositoryUrl: "[redacted]" };
    }

    return conn;
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

    // Check bounty ownership
    const bounty = await ctx.db.get(args.bountyId);
    if (!bounty) throw new Error("Bounty not found");
    if (bounty.creatorId !== user._id && user.role !== "admin") {
      throw new Error("Unauthorized");
    }

    // Validate repository URL format
    if (!/^https?:\/\/(github\.com|gitlab\.com|bitbucket\.org)\/[\w.-]+\/[\w.-]+/.test(args.repositoryUrl)) {
      throw new Error("Invalid repository URL. Please use a GitHub, GitLab, or Bitbucket URL.");
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

export const createInternal = internalMutation({
  args: {
    bountyId: v.id("bounties"),
    repositoryUrl: v.string(),
  },
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("repoConnections", {
      bountyId: args.bountyId,
      repositoryUrl: args.repositoryUrl,
      owner: "",
      repo: "",
      defaultBranch: "main",
      commitSha: "",
      status: "pending",
    });

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
      v.literal("failed"),
      v.literal("cleaned")
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

    // Auto-save repo for the bounty creator
    const repoConnection = await ctx.db.get(args.repoConnectionId);
    if (repoConnection) {
      const bounty = await ctx.db.get(repoConnection.bountyId);
      if (bounty) {
        await ctx.runMutation(internal.savedRepos.upsert, {
          userId: bounty.creatorId,
          repositoryUrl: repoConnection.repositoryUrl,
          owner: repoConnection.owner,
          repo: repoConnection.repo,
          languages: repoConnection.languages,
        });
      }
    }
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

/**
 * Trigger a re-index of a repo connection with a new commit SHA.
 * Called by the GitHub webhook handler or the cron fallback.
 */
export const triggerReIndex = internalMutation({
  args: {
    repoConnectionId: v.id("repoConnections"),
    newCommitSha: v.string(),
  },
  handler: async (ctx, args) => {
    const conn = await ctx.db.get(args.repoConnectionId);
    if (!conn) throw new Error("Repo connection not found");

    await ctx.db.patch(args.repoConnectionId, {
      status: "fetching",
      commitSha: args.newCommitSha,
      errorMessage: undefined,
    });

    await ctx.scheduler.runAfter(0, internal.pipelines.fetchRepo.fetchRepo, {
      repoConnectionId: args.repoConnectionId,
      bountyId: conn.bountyId,
      repositoryUrl: conn.repositoryUrl,
    });
  },
});

/**
 * Cron-driven check for tracked repos that may have new commits.
 * Polls GitHub API for HEAD commit on the tracked branch.
 */
export const checkForUpdates = internalAction({
  args: {},
  handler: async (ctx) => {
    const token = process.env.GITHUB_API_TOKEN;
    if (!token) {
      console.warn("[checkForUpdates] GITHUB_API_TOKEN not set, skipping");
      return;
    }

    const readyConnections = await ctx.runQuery(
      internal.repoConnections.listReady
    );

    for (const conn of readyConnections) {
      if (!conn.owner || !conn.repo) continue;

      const branch = conn.trackedBranch || conn.defaultBranch;
      try {
        const response = await fetch(
          `https://api.github.com/repos/${conn.owner}/${conn.repo}/commits/${branch}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github.v3+json",
              "User-Agent": "arcagent",
            },
          }
        );

        if (!response.ok) continue;

        const data = await response.json();
        const headSha = data.sha as string;

        if (headSha && headSha !== conn.commitSha) {
          console.log(
            `[checkForUpdates] New commit on ${conn.owner}/${conn.repo}@${branch}: ${headSha}`
          );
          await ctx.runMutation(internal.repoConnections.triggerReIndex, {
            repoConnectionId: conn._id,
            newCommitSha: headSha,
          });
        }
      } catch (error) {
        console.warn(
          `[checkForUpdates] Failed to check ${conn.owner}/${conn.repo}: ${error}`
        );
      }
    }
  },
});

/** List all ready repo connections (used by cron) */
export const listReady = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("repoConnections")
      .withIndex("by_status", (q) => q.eq("status", "ready"))
      .collect();
  },
});

/** Store detected .feature files on a repo connection */
export const storeDetectedFeatures = internalMutation({
  args: {
    repoConnectionId: v.id("repoConnections"),
    detectedFeatureFiles: v.array(v.object({
      filePath: v.string(),
      content: v.string(),
    })),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.repoConnectionId, {
      detectedFeatureFiles: args.detectedFeatureFiles,
    });
  },
});

/** Get detected .feature files for a bounty (frontend use) */
export const getDetectedFeatures = query({
  args: { bountyId: v.id("bounties") },
  handler: async (ctx, args) => {
    await requireBountyAccess(ctx, args.bountyId);

    const conn = await ctx.db
      .query("repoConnections")
      .withIndex("by_bountyId", (q) => q.eq("bountyId", args.bountyId))
      .first();

    return conn?.detectedFeatureFiles ?? [];
  },
});

/** Retry a failed repo connection indexing */
export const retryIndexing = mutation({
  args: { repoConnectionId: v.id("repoConnections") },
  handler: async (ctx, args) => {
    const user = requireAuth(await getCurrentUser(ctx));
    const conn = await ctx.db.get(args.repoConnectionId);
    if (!conn) throw new Error("Repo connection not found");

    const bounty = await ctx.db.get(conn.bountyId);
    if (!bounty) throw new Error("Bounty not found");
    if (bounty.creatorId !== user._id && user.role !== "admin") {
      throw new Error("Unauthorized");
    }

    if (conn.status !== "failed") {
      throw new Error("Can only retry failed connections");
    }

    await ctx.db.patch(args.repoConnectionId, {
      status: "pending",
      errorMessage: undefined,
    });

    await ctx.scheduler.runAfter(0, internal.pipelines.fetchRepo.fetchRepo, {
      repoConnectionId: args.repoConnectionId,
      bountyId: conn.bountyId,
      repositoryUrl: conn.repositoryUrl,
    });
  },
});

/** Store webhook ID on a repo connection */
export const updateWebhookId = internalMutation({
  args: {
    repoConnectionId: v.id("repoConnections"),
    webhookId: v.string(),
    trackedBranch: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const updates: Record<string, unknown> = { webhookId: args.webhookId };
    if (args.trackedBranch !== undefined) {
      updates.trackedBranch = args.trackedBranch;
    }
    await ctx.db.patch(args.repoConnectionId, updates);
  },
});
