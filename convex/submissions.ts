import { query, mutation, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { getCurrentUser, requireAuth } from "./lib/utils";

export const listByBounty = query({
  args: { bountyId: v.id("bounties") },
  handler: async (ctx, args) => {
    const submissions = await ctx.db
      .query("submissions")
      .withIndex("by_bountyId", (q) => q.eq("bountyId", args.bountyId))
      .collect();

    // SECURITY: Determine if the viewer is the bounty creator.
    // If so, redact repositoryUrl and commitHash on non-terminal submissions
    // to prevent creators from inspecting agent work before verification completes.
    const user = await getCurrentUser(ctx);
    const bounty = await ctx.db.get(args.bountyId);
    const isCreator =
      user && bounty && bounty.creatorId === user._id;

    return await Promise.all(
      submissions.map(async (sub) => {
        const agent = await ctx.db.get(sub.agentId);
        if (isCreator && sub.status !== "passed" && sub.status !== "failed") {
          return {
            ...sub,
            repositoryUrl: "[redacted until verification completes]",
            commitHash: "[redacted until verification completes]",
            agent,
          };
        }
        return { ...sub, agent };
      })
    );
  },
});

export const listByAgent = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUser(ctx);
    if (!user) return [];

    const submissions = await ctx.db
      .query("submissions")
      .withIndex("by_agentId", (q) => q.eq("agentId", user._id))
      .collect();

    return await Promise.all(
      submissions.map(async (sub) => {
        const bounty = await ctx.db.get(sub.bountyId);
        return { ...sub, bounty };
      })
    );
  },
});

export const getById = query({
  args: { submissionId: v.id("submissions") },
  handler: async (ctx, args) => {
    const submission = await ctx.db.get(args.submissionId);
    if (!submission) return null;

    const agent = await ctx.db.get(submission.agentId);
    const bounty = await ctx.db.get(submission.bountyId);
    return { ...submission, agent, bounty };
  },
});

export const create = mutation({
  args: {
    bountyId: v.id("bounties"),
    repositoryUrl: v.string(),
    commitHash: v.string(),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = requireAuth(await getCurrentUser(ctx));

    const bounty = await ctx.db.get(args.bountyId);
    if (!bounty) throw new Error("Bounty not found");
    if (bounty.status !== "active" && bounty.status !== "in_progress") {
      throw new Error("Bounty is not accepting submissions");
    }

    // SECURITY (P2-6): Reject submissions after bounty deadline
    if (bounty.deadline && bounty.deadline < Date.now()) {
      throw new Error("Bounty deadline has passed");
    }

    // Verify agent has active claim on this bounty
    const activeClaim = await ctx.db
      .query("bountyClaims")
      .withIndex("by_bountyId_and_status", (q) =>
        q.eq("bountyId", args.bountyId).eq("status", "active")
      )
      .first();

    if (!activeClaim || activeClaim.agentId !== user._id) {
      throw new Error("You must have an active claim on this bounty to submit");
    }

    // Rate limit: only 1 pending/running submission per agent per bounty
    const pendingSubmissions = await ctx.db
      .query("submissions")
      .withIndex("by_bountyId_and_status", (q) =>
        q.eq("bountyId", args.bountyId).eq("status", "pending")
      )
      .collect();
    if (pendingSubmissions.some((s) => s.agentId === user._id)) {
      throw new Error("You already have a pending submission for this bounty");
    }

    const runningSubmissions = await ctx.db
      .query("submissions")
      .withIndex("by_bountyId_and_status", (q) =>
        q.eq("bountyId", args.bountyId).eq("status", "running")
      )
      .collect();
    if (runningSubmissions.some((s) => s.agentId === user._id)) {
      throw new Error("You already have a running verification for this bounty");
    }

    return await ctx.db.insert("submissions", {
      bountyId: args.bountyId,
      agentId: user._id,
      repositoryUrl: args.repositoryUrl,
      commitHash: args.commitHash,
      status: "pending",
      description: args.description,
    });
  },
});

export const getByIdInternal = internalQuery({
  args: { submissionId: v.id("submissions") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.submissionId);
  },
});

export const updateStatus = internalMutation({
  args: {
    submissionId: v.id("submissions"),
    status: v.union(
      v.literal("pending"),
      v.literal("running"),
      v.literal("passed"),
      v.literal("failed")
    ),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.submissionId, { status: args.status });
  },
});

// SECURITY (H7): Maximum total submissions per agent per bounty (across all statuses)
const MAX_SUBMISSIONS_PER_BOUNTY = 5;

export const createFromMcp = internalMutation({
  args: {
    bountyId: v.id("bounties"),
    agentId: v.id("users"),
    repositoryUrl: v.string(),
    commitHash: v.string(),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const bounty = await ctx.db.get(args.bountyId);
    if (!bounty) throw new Error("Bounty not found");
    if (bounty.status !== "active" && bounty.status !== "in_progress") {
      throw new Error("Bounty is not accepting submissions");
    }

    // SECURITY (P2-6): Reject submissions after bounty deadline
    if (bounty.deadline && bounty.deadline < Date.now()) {
      throw new Error("Bounty deadline has passed");
    }

    // Validate commit hash format
    if (!/^[a-f0-9]{7,40}$/i.test(args.commitHash)) {
      throw new Error("Invalid commit hash");
    }

    // Verify agent has active claim on this bounty
    const activeClaim = await ctx.db
      .query("bountyClaims")
      .withIndex("by_bountyId_and_status", (q) =>
        q.eq("bountyId", args.bountyId).eq("status", "active")
      )
      .first();

    if (!activeClaim || activeClaim.agentId !== args.agentId) {
      throw new Error("You must have an active claim on this bounty to submit");
    }

    // SECURITY (H7): Limit total submissions per agent per bounty
    const allSubmissions = await ctx.db
      .query("submissions")
      .withIndex("by_bountyId", (q) => q.eq("bountyId", args.bountyId))
      .collect();
    const agentSubmissionCount = allSubmissions.filter(
      (s) => s.agentId === args.agentId
    ).length;
    if (agentSubmissionCount >= MAX_SUBMISSIONS_PER_BOUNTY) {
      throw new Error(
        `Maximum attempts reached (${MAX_SUBMISSIONS_PER_BOUNTY} per bounty). No more submissions allowed.`
      );
    }

    // Rate limit: only 1 pending/running submission per agent per bounty
    const pendingSubmissions = await ctx.db
      .query("submissions")
      .withIndex("by_bountyId_and_status", (q) =>
        q.eq("bountyId", args.bountyId).eq("status", "pending")
      )
      .collect();
    if (pendingSubmissions.some((s) => s.agentId === args.agentId)) {
      throw new Error("You already have a pending submission for this bounty");
    }

    const runningSubmissions = await ctx.db
      .query("submissions")
      .withIndex("by_bountyId_and_status", (q) =>
        q.eq("bountyId", args.bountyId).eq("status", "running")
      )
      .collect();
    if (runningSubmissions.some((s) => s.agentId === args.agentId)) {
      throw new Error("You already have a running verification for this bounty");
    }

    return await ctx.db.insert("submissions", {
      bountyId: args.bountyId,
      agentId: args.agentId,
      repositoryUrl: args.repositoryUrl,
      commitHash: args.commitHash,
      status: "pending",
      description: args.description,
    });
  },
});

export const listByAgentId = internalQuery({
  args: {
    agentId: v.id("users"),
    bountyId: v.optional(v.id("bounties")),
    status: v.optional(
      v.union(
        v.literal("pending"),
        v.literal("running"),
        v.literal("passed"),
        v.literal("failed")
      )
    ),
  },
  handler: async (ctx, args) => {
    let submissions;

    if (args.bountyId) {
      submissions = await ctx.db
        .query("submissions")
        .withIndex("by_bountyId", (q) => q.eq("bountyId", args.bountyId!))
        .collect();
      submissions = submissions.filter((s) => s.agentId === args.agentId);
    } else {
      submissions = await ctx.db
        .query("submissions")
        .withIndex("by_agentId", (q) => q.eq("agentId", args.agentId))
        .collect();
    }

    if (args.status) {
      submissions = submissions.filter((s) => s.status === args.status);
    }

    return await Promise.all(
      submissions.map(async (sub) => {
        const bounty = await ctx.db.get(sub.bountyId);
        return { ...sub, bounty };
      })
    );
  },
});
