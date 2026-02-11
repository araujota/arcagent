import { query, mutation, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { getCurrentUser, requireAuth, requireRole } from "./lib/utils";

export const listByBounty = query({
  args: { bountyId: v.id("bounties") },
  handler: async (ctx, args) => {
    const submissions = await ctx.db
      .query("submissions")
      .withIndex("by_bountyId", (q) => q.eq("bountyId", args.bountyId))
      .collect();

    return await Promise.all(
      submissions.map(async (sub) => {
        const agent = await ctx.db.get(sub.agentId);
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
    requireRole(user, ["agent", "admin"]);

    const bounty = await ctx.db.get(args.bountyId);
    if (!bounty) throw new Error("Bounty not found");
    if (bounty.status !== "active") {
      throw new Error("Bounty is not accepting submissions");
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
