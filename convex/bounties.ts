import { query, mutation, action, internalQuery, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { getCurrentUser, requireAuth } from "./lib/utils";
import { api, internal } from "./_generated/api";

export const list = query({
  args: {
    status: v.optional(
      v.union(
        v.literal("draft"),
        v.literal("active"),
        v.literal("in_progress"),
        v.literal("completed"),
        v.literal("disputed"),
        v.literal("cancelled")
      )
    ),
    paymentMethod: v.optional(
      v.union(v.literal("stripe"), v.literal("web3"))
    ),
    search: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = requireAuth(await getCurrentUser(ctx));

    let bounties;

    if (args.status) {
      bounties = await ctx.db
        .query("bounties")
        .withIndex("by_status", (q) => q.eq("status", args.status!))
        .collect();
    } else {
      bounties = await ctx.db.query("bounties").collect();
    }

    // Ownership-based filtering: everyone sees their own bounties + public ones
    if (user.role === "admin") {
      // Admins see all
    } else {
      bounties = bounties.filter(
        (b) =>
          b.creatorId === user._id ||
          b.status === "active" ||
          b.status === "in_progress"
      );
    }

    if (args.paymentMethod) {
      bounties = bounties.filter(
        (b) => b.paymentMethod === args.paymentMethod
      );
    }

    if (args.search) {
      const search = args.search.toLowerCase();
      bounties = bounties.filter(
        (b) =>
          b.title.toLowerCase().includes(search) ||
          b.description.toLowerCase().includes(search)
      );
    }

    // Fetch creator info and strip sensitive fields
    const isPrivileged = user.role === "admin";

    const bountiesWithCreators = await Promise.all(
      bounties.map(async (bounty) => {
        const creator = await ctx.db.get(bounty.creatorId);
        const isOwner = bounty.creatorId === user._id;

        if (isPrivileged || isOwner) {
          return { ...bounty, creator };
        }

        // Strip sensitive fields for non-owner, non-admin
        const {
          repositoryUrl: _repoUrl,
          repoConnectionId: _repoConn,
          stripePaymentIntentId: _stripe,
          ...safe
        } = bounty;
        return { ...safe, creator };
      })
    );

    return bountiesWithCreators;
  },
});

export const getById = query({
  args: { bountyId: v.id("bounties") },
  handler: async (ctx, args) => {
    const user = requireAuth(await getCurrentUser(ctx));

    const bounty = await ctx.db.get(args.bountyId);
    if (!bounty) return null;

    const creator = await ctx.db.get(bounty.creatorId);
    const isOwner = bounty.creatorId === user._id;
    const isAdmin = user.role === "admin";

    if (isOwner || isAdmin) {
      return { ...bounty, creator };
    }

    // Strip sensitive fields for non-creator, non-admin
    const {
      repositoryUrl: _repoUrl,
      stripePaymentIntentId: _stripe,
      ...safe
    } = bounty;
    return { ...safe, creator };
  },
});

export const listByCreator = query({
  args: {
    status: v.optional(
      v.union(
        v.literal("draft"),
        v.literal("active"),
        v.literal("in_progress"),
        v.literal("completed"),
        v.literal("disputed"),
        v.literal("cancelled")
      )
    ),
  },
  handler: async (ctx, args) => {
    const user = await getCurrentUser(ctx);
    if (!user) return [];

    if (args.status) {
      return await ctx.db
        .query("bounties")
        .withIndex("by_creatorId_and_status", (q) =>
          q.eq("creatorId", user._id).eq("status", args.status!)
        )
        .collect();
    }

    return await ctx.db
      .query("bounties")
      .withIndex("by_creatorId", (q) => q.eq("creatorId", user._id))
      .collect();
  },
});

export const create = mutation({
  args: {
    title: v.string(),
    description: v.string(),
    reward: v.number(),
    rewardCurrency: v.string(),
    paymentMethod: v.union(v.literal("stripe"), v.literal("web3")),
    deadline: v.optional(v.number()),
    repositoryUrl: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    status: v.optional(
      v.union(v.literal("draft"), v.literal("active"))
    ),
  },
  handler: async (ctx, args) => {
    const user = requireAuth(await getCurrentUser(ctx));

    // Input validation
    if (args.reward <= 0) throw new Error("Reward must be positive");
    if (args.title.trim().length === 0) throw new Error("Title is required");
    if (args.description.trim().length < 10) throw new Error("Description too short");
    if (args.deadline && args.deadline < Date.now()) throw new Error("Deadline must be in the future");

    // Web3 payments are not yet supported
    if (args.paymentMethod === "web3") {
      throw new Error("Web3 payments are coming soon. Please use Stripe.");
    }

    return await ctx.db.insert("bounties", {
      title: args.title,
      description: args.description,
      creatorId: user._id,
      status: args.status ?? "draft",
      reward: args.reward,
      rewardCurrency: args.rewardCurrency,
      paymentMethod: args.paymentMethod,
      deadline: args.deadline,
      repositoryUrl: args.repositoryUrl,
      tags: args.tags,
    });
  },
});

export const update = mutation({
  args: {
    bountyId: v.id("bounties"),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    reward: v.optional(v.number()),
    rewardCurrency: v.optional(v.string()),
    paymentMethod: v.optional(
      v.union(v.literal("stripe"), v.literal("web3"))
    ),
    deadline: v.optional(v.number()),
    repositoryUrl: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const user = requireAuth(await getCurrentUser(ctx));
    const bounty = await ctx.db.get(args.bountyId);
    if (!bounty) throw new Error("Bounty not found");
    if (bounty.creatorId !== user._id && user.role !== "admin") {
      throw new Error("Unauthorized");
    }

    // SECURITY (H2): Freeze critical terms once an agent has claimed
    const frozenStatuses = ["in_progress", "completed"];
    if (frozenStatuses.includes(bounty.status)) {
      const frozenFields = ["reward", "rewardCurrency", "description", "paymentMethod"] as const;
      for (const field of frozenFields) {
        if (args[field] !== undefined && args[field] !== bounty[field]) {
          throw new Error(
            `Cannot modify "${field}" while bounty is ${bounty.status}`
          );
        }
      }
    }

    const { bountyId, ...updates } = args;
    const filteredUpdates = Object.fromEntries(
      Object.entries(updates).filter(([, v]) => v !== undefined)
    );

    await ctx.db.patch(bountyId, filteredUpdates);
    return bountyId;
  },
});

const VALID_STATUS_TRANSITIONS: Record<string, string[]> = {
  draft: ["active", "cancelled"],
  active: ["in_progress", "cancelled"],
  in_progress: ["active", "completed", "disputed", "cancelled"],
  completed: [],
  disputed: ["completed", "cancelled"],
  cancelled: [],
};

export const updateStatus = mutation({
  args: {
    bountyId: v.id("bounties"),
    status: v.union(
      v.literal("draft"),
      v.literal("active"),
      v.literal("in_progress"),
      v.literal("completed"),
      v.literal("disputed"),
      v.literal("cancelled")
    ),
  },
  handler: async (ctx, args) => {
    const user = requireAuth(await getCurrentUser(ctx));
    const bounty = await ctx.db.get(args.bountyId);
    if (!bounty) throw new Error("Bounty not found");
    if (bounty.creatorId !== user._id && user.role !== "admin") {
      throw new Error("Unauthorized");
    }

    const allowed = VALID_STATUS_TRANSITIONS[bounty.status] ?? [];
    if (!allowed.includes(args.status)) {
      throw new Error(`Cannot transition from "${bounty.status}" to "${args.status}"`);
    }

    // SECURITY (H1): Block activation of unfunded Stripe bounties
    if (
      args.status === "active" &&
      bounty.paymentMethod === "stripe" &&
      bounty.escrowStatus !== "funded"
    ) {
      throw new Error("Cannot activate: escrow must be funded first");
    }

    await ctx.db.patch(args.bountyId, { status: args.status });

    // Notify agents when bounty becomes active
    if (args.status === "active") {
      await ctx.scheduler.runAfter(0, internal.notifications.createForNewBounty, {
        bountyId: args.bountyId,
        title: bounty.title,
        reward: bounty.reward,
        rewardCurrency: bounty.rewardCurrency,
        tags: bounty.tags,
      });
      await ctx.scheduler.runAfter(0, internal.activityFeed.record, {
        type: "bounty_posted",
        bountyId: args.bountyId,
        bountyTitle: bounty.title,
        amount: bounty.reward,
        currency: bounty.rewardCurrency,
      });
    }

    return args.bountyId;
  },
});

export const listForMcp = internalQuery({
  args: {
    status: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    minReward: v.optional(v.number()),
    maxReward: v.optional(v.number()),
    search: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    let bounties;

    if (args.status) {
      bounties = await ctx.db
        .query("bounties")
        .withIndex("by_status", (q) => q.eq("status", args.status as "active"))
        .collect();
    } else {
      // Default to active bounties for MCP
      bounties = await ctx.db
        .query("bounties")
        .withIndex("by_status", (q) => q.eq("status", "active"))
        .collect();
    }

    // Always exclude cancelled bounties from MCP results
    bounties = bounties.filter((b) => b.status !== "cancelled");

    if (args.minReward !== undefined) {
      bounties = bounties.filter((b) => b.reward >= args.minReward!);
    }
    if (args.maxReward !== undefined) {
      bounties = bounties.filter((b) => b.reward <= args.maxReward!);
    }

    if (args.tags && args.tags.length > 0) {
      bounties = bounties.filter((b) =>
        b.tags?.some((t) => args.tags!.includes(t))
      );
    }

    if (args.search) {
      const search = args.search.toLowerCase();
      bounties = bounties.filter(
        (b) =>
          b.title.toLowerCase().includes(search) ||
          b.description.toLowerCase().includes(search)
      );
    }

    const limit = args.limit ?? 50;
    bounties = bounties.slice(0, limit);

    return bounties.map((b) => ({
      _id: b._id,
      title: b.title,
      description: b.description,
      status: b.status,
      reward: b.reward,
      rewardCurrency: b.rewardCurrency,
      tags: b.tags,
      deadline: b.deadline,
      claimDurationHours: b.claimDurationHours,
    }));
  },
});

export const getForMcp = internalQuery({
  args: { bountyId: v.id("bounties") },
  handler: async (ctx, args) => {
    const bounty = await ctx.db.get(args.bountyId);
    if (!bounty) return null;

    const creator = await ctx.db.get(bounty.creatorId);

    // Get ALL test suites (public + hidden) — agents see all Gherkin as their spec
    const testSuites = await ctx.db
      .query("testSuites")
      .withIndex("by_bountyId", (q) => q.eq("bountyId", args.bountyId))
      .collect();

    // Get test framework/language metadata from generated tests
    const generatedTest = await ctx.db
      .query("generatedTests")
      .withIndex("by_bountyId", (q) => q.eq("bountyId", args.bountyId))
      .order("desc")
      .first();

    // Get repo map
    const repoMap = await ctx.db
      .query("repoMaps")
      .withIndex("by_bountyId", (q) => q.eq("bountyId", args.bountyId))
      .order("desc")
      .first();

    // Get active claim info
    const activeClaim = await ctx.db
      .query("bountyClaims")
      .withIndex("by_bountyId_and_status", (q) =>
        q.eq("bountyId", args.bountyId).eq("status", "active")
      )
      .first();

    // SECURITY: Explicit allowlist — never spread the full bounty document.
    // Omits: repositoryUrl, repoConnectionId, creatorId, paymentMethod,
    //        stripePaymentIntentId, escrowStatus
    return {
      _id: bounty._id,
      title: bounty.title,
      description: bounty.description,
      status: bounty.status,
      reward: bounty.reward,
      rewardCurrency: bounty.rewardCurrency,
      tags: bounty.tags,
      deadline: bounty.deadline,
      creator: creator ? { name: creator.name } : null,
      testSuites: testSuites.map((ts) => ({
        _id: ts._id,
        title: ts.title,
        version: ts.version,
        gherkinContent: ts.gherkinContent,
        visibility: ts.visibility,
      })),
      testFramework: generatedTest?.testFramework ?? null,
      testLanguage: generatedTest?.testLanguage ?? null,
      repoMap: repoMap
        ? {
            repoMapText: repoMap.repoMapText,
            symbolTableJson: repoMap.symbolTableJson,
            dependencyGraphJson: repoMap.dependencyGraphJson,
          }
        : null,
      isClaimed: !!activeClaim,
      claimDurationHours: bounty.claimDurationHours ?? 4,
      platformFeePercent: bounty.platformFeePercent,
      relevantPaths: bounty.relevantPaths,
    };
  },
});

export const createFromMcp = internalMutation({
  args: {
    creatorId: v.id("users"),
    title: v.string(),
    description: v.string(),
    reward: v.number(),
    rewardCurrency: v.string(),
    paymentMethod: v.union(v.literal("stripe"), v.literal("web3")),
    deadline: v.optional(v.number()),
    tags: v.optional(v.array(v.string())),
    status: v.optional(v.union(v.literal("draft"), v.literal("active"))),
  },
  handler: async (ctx, args) => {
    // Input validation
    if (args.reward <= 0) throw new Error("Reward must be positive");
    if (args.title.trim().length === 0) throw new Error("Title is required");
    if (args.description.trim().length < 10) throw new Error("Description too short");
    if (args.deadline && args.deadline < Date.now()) throw new Error("Deadline must be in the future");

    // Web3 payments are not yet supported
    if (args.paymentMethod === "web3") {
      throw new Error("Web3 payments are coming soon. Please use Stripe.");
    }

    const status = args.status ?? "active";
    const bountyId = await ctx.db.insert("bounties", {
      title: args.title,
      description: args.description,
      creatorId: args.creatorId,
      status,
      reward: args.reward,
      rewardCurrency: args.rewardCurrency,
      paymentMethod: args.paymentMethod,
      deadline: args.deadline,
      tags: args.tags,
    });

    if (status === "active") {
      await ctx.scheduler.runAfter(0, internal.notifications.createForNewBounty, {
        bountyId,
        title: args.title,
        reward: args.reward,
        rewardCurrency: args.rewardCurrency,
        tags: args.tags,
      });
      await ctx.scheduler.runAfter(0, internal.activityFeed.record, {
        type: "bounty_posted",
        bountyId,
        bountyTitle: args.title,
        amount: args.reward,
        currency: args.rewardCurrency,
      });
    }

    return bountyId;
  },
});

export const getByIdInternal = internalQuery({
  args: { bountyId: v.id("bounties") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.bountyId);
  },
});

export const updateStatusInternal = internalMutation({
  args: {
    bountyId: v.id("bounties"),
    status: v.union(
      v.literal("draft"),
      v.literal("active"),
      v.literal("in_progress"),
      v.literal("completed"),
      v.literal("disputed"),
      v.literal("cancelled")
    ),
  },
  handler: async (ctx, args) => {
    const bounty = await ctx.db.get(args.bountyId);
    if (!bounty) throw new Error("Bounty not found");

    const allowed = VALID_STATUS_TRANSITIONS[bounty.status] ?? [];
    if (!allowed.includes(args.status)) {
      throw new Error(`Cannot transition from "${bounty.status}" to "${args.status}"`);
    }

    // SECURITY (H1): Block activation of unfunded Stripe bounties
    if (
      args.status === "active" &&
      bounty.paymentMethod === "stripe" &&
      bounty.escrowStatus !== "funded"
    ) {
      throw new Error("Cannot activate: escrow must be funded first");
    }

    await ctx.db.patch(args.bountyId, { status: args.status });
  },
});

/**
 * Shared cancellation logic used by both the authenticated mutation
 * (web UI) and the internal mutation (MCP server).
 *
 * Guards:
 * - Bounty must not already be completed or cancelled
 * - No active claim may exist (agent is working on it)
 * - No pending/running submissions (verification in progress)
 *
 * Side-effects on success:
 * - Bounty status → "cancelled"
 * - Escrow refund scheduled if funded
 * - Repo data cleanup scheduled
 */
async function cancelBountyImpl(
  ctx: { db: any; scheduler: any },
  bountyId: any,
) {
  const bounty = await ctx.db.get(bountyId);
  if (!bounty) throw new Error("Bounty not found");

  if (bounty.status === "completed" || bounty.status === "cancelled") {
    throw new Error(`Cannot cancel a ${bounty.status} bounty`);
  }

  // Block if active claim exists
  const activeClaim = await ctx.db
    .query("bountyClaims")
    .withIndex("by_bountyId_and_status", (q: any) =>
      q.eq("bountyId", bountyId).eq("status", "active")
    )
    .first();
  if (activeClaim) {
    throw new Error(
      "Cannot cancel: an agent has an active claim on this bounty"
    );
  }

  // Block if any submission is pending or running (verification in progress)
  const activeSubmission = await ctx.db
    .query("submissions")
    .withIndex("by_bountyId", (q: any) => q.eq("bountyId", bountyId))
    .filter((q: any) =>
      q.or(
        q.eq(q.field("status"), "pending"),
        q.eq(q.field("status"), "running")
      )
    )
    .first();
  if (activeSubmission) {
    throw new Error(
      "Cannot cancel: a submission is currently being verified"
    );
  }

  await ctx.db.patch(bountyId, { status: "cancelled" });

  // Schedule escrow refund if funded
  if (bounty.escrowStatus === "funded") {
    await ctx.scheduler.runAfter(0, internal.stripe.refundEscrow, {
      bountyId,
    });
  }

  // Schedule cleanup of repo data (Qdrant vectors, codeChunks, repoMaps)
  await ctx.scheduler.runAfter(
    0,
    internal.pipelines.cleanupRepoData.cleanupRepoData,
    { bountyId }
  );

  return bounty;
}

export const cancelBounty = mutation({
  args: { bountyId: v.id("bounties") },
  handler: async (ctx, args) => {
    const user = requireAuth(await getCurrentUser(ctx));
    const bounty = await ctx.db.get(args.bountyId);
    if (!bounty) throw new Error("Bounty not found");
    if (bounty.creatorId !== user._id && user.role !== "admin") {
      throw new Error("Unauthorized");
    }
    await cancelBountyImpl(ctx, args.bountyId);
  },
});

/**
 * Internal mutation for MCP server — same cancellation logic,
 * but auth is handled at the HTTP layer (shared secret + API key).
 */
export const cancelFromMcp = internalMutation({
  args: {
    bountyId: v.id("bounties"),
    creatorId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const bounty = await ctx.db.get(args.bountyId);
    if (!bounty) throw new Error("Bounty not found");
    if (bounty.creatorId !== args.creatorId) {
      throw new Error("Unauthorized: you can only cancel your own bounties");
    }
    const cancelled = await cancelBountyImpl(ctx, args.bountyId);
    return {
      bountyId: args.bountyId,
      previousStatus: cancelled.status,
      escrowRefundScheduled: cancelled.escrowStatus === "funded",
    };
  },
});

export const getPublicView = internalQuery({
  args: { bountyId: v.id("bounties") },
  handler: async (ctx, args) => {
    const bounty = await ctx.db.get(args.bountyId);
    if (!bounty || bounty.status === "cancelled") return null;

    const creator = await ctx.db.get(bounty.creatorId);

    const publicTests = await ctx.db
      .query("testSuites")
      .withIndex("by_bountyId_and_visibility", (q) =>
        q.eq("bountyId", args.bountyId).eq("visibility", "public")
      )
      .collect();

    const hiddenTests = await ctx.db
      .query("testSuites")
      .withIndex("by_bountyId_and_visibility", (q) =>
        q.eq("bountyId", args.bountyId).eq("visibility", "hidden")
      )
      .collect();

    return {
      _id: bounty._id,
      title: bounty.title,
      description: bounty.description,
      status: bounty.status,
      reward: bounty.reward,
      rewardCurrency: bounty.rewardCurrency,
      tags: bounty.tags,
      deadline: bounty.deadline,
      creatorName: creator?.name ?? "Unknown",
      publicTestCount: publicTests.length,
      hiddenTestCount: hiddenTests.length,
      claimDurationHours: bounty.claimDurationHours,
    };
  },
});

/**
 * Connect a repository to a bounty and trigger indexing.
 */
export const connectRepo = action({
  args: {
    bountyId: v.id("bounties"),
    repositoryUrl: v.string(),
  },
  handler: async (ctx, args) => {
    // Create repo connection
    const repoConnectionId = await ctx.runMutation(
      api.repoConnections.create,
      {
        bountyId: args.bountyId,
        repositoryUrl: args.repositoryUrl,
      }
    );

    // Trigger the indexing pipeline
    await ctx.runAction(api.orchestrator.connectAndIndexRepo, {
      bountyId: args.bountyId,
      repoConnectionId,
      repositoryUrl: args.repositoryUrl,
    });

    return repoConnectionId;
  },
});
