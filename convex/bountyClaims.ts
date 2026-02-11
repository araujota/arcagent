import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";

const DEFAULT_CLAIM_DURATION_HOURS = 4;

export const create = internalMutation({
  args: {
    bountyId: v.id("bounties"),
    agentId: v.id("users"),
  },
  handler: async (ctx, args) => {
    // Check bounty exists and is active
    const bounty = await ctx.db.get(args.bountyId);
    if (!bounty) throw new Error("Bounty not found");
    if (bounty.status !== "active") {
      throw new Error("Bounty is not active");
    }

    // Check no other agent has an active claim on this bounty
    const existingClaim = await ctx.db
      .query("bountyClaims")
      .withIndex("by_bountyId_and_status", (q) =>
        q.eq("bountyId", args.bountyId).eq("status", "active")
      )
      .first();

    if (existingClaim) {
      throw new Error("Bounty already has an active claim");
    }

    // Check this agent doesn't already have an active claim on this bounty
    const agentClaims = await ctx.db
      .query("bountyClaims")
      .withIndex("by_agentId_and_status", (q) =>
        q.eq("agentId", args.agentId).eq("status", "active")
      )
      .collect();

    const existingAgentClaim = agentClaims.find(
      (c) => c.bountyId === args.bountyId
    );
    if (existingAgentClaim) {
      throw new Error("You already have an active claim on this bounty");
    }

    const durationHours = bounty.claimDurationHours ?? DEFAULT_CLAIM_DURATION_HOURS;
    const now = Date.now();
    const expiresAt = now + durationHours * 60 * 60 * 1000;

    return await ctx.db.insert("bountyClaims", {
      bountyId: args.bountyId,
      agentId: args.agentId,
      status: "active",
      claimedAt: now,
      expiresAt,
    });
  },
});

export const release = internalMutation({
  args: {
    claimId: v.id("bountyClaims"),
    agentId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const claim = await ctx.db.get(args.claimId);
    if (!claim) throw new Error("Claim not found");
    if (claim.agentId !== args.agentId) {
      throw new Error("Not your claim");
    }
    if (claim.status !== "active") {
      throw new Error("Claim is not active");
    }

    await ctx.db.patch(args.claimId, {
      status: "released",
      releasedAt: Date.now(),
    });
  },
});

export const expireStale = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();

    // Find all active claims that have expired
    const activeClaims = await ctx.db
      .query("bountyClaims")
      .withIndex("by_expiresAt")
      .collect();

    let expiredCount = 0;
    for (const claim of activeClaims) {
      if (claim.status === "active" && claim.expiresAt < now) {
        await ctx.db.patch(claim._id, { status: "expired" });
        expiredCount++;
      }
    }

    if (expiredCount > 0) {
      console.log(`Expired ${expiredCount} stale bounty claims`);
    }
  },
});

export const extendExpiration = internalMutation({
  args: {
    claimId: v.id("bountyClaims"),
    agentId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const claim = await ctx.db.get(args.claimId);
    if (!claim) throw new Error("Claim not found");
    if (claim.agentId !== args.agentId) {
      throw new Error("Not your claim");
    }
    if (claim.status !== "active") {
      throw new Error("Claim is not active");
    }

    const bounty = await ctx.db.get(claim.bountyId);
    const durationHours = bounty?.claimDurationHours ?? DEFAULT_CLAIM_DURATION_HOURS;
    const newExpiresAt = Date.now() + durationHours * 60 * 60 * 1000;

    await ctx.db.patch(args.claimId, { expiresAt: newExpiresAt });

    return { expiresAt: newExpiresAt };
  },
});

export const getActiveByClaim = internalQuery({
  args: {
    bountyId: v.id("bounties"),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("bountyClaims")
      .withIndex("by_bountyId_and_status", (q) =>
        q.eq("bountyId", args.bountyId).eq("status", "active")
      )
      .first();
  },
});

export const getActiveByAgent = internalQuery({
  args: {
    agentId: v.id("users"),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("bountyClaims")
      .withIndex("by_agentId_and_status", (q) =>
        q.eq("agentId", args.agentId).eq("status", "active")
      )
      .collect();
  },
});

export const getByAgentAndBounty = internalQuery({
  args: {
    agentId: v.id("users"),
    bountyId: v.id("bounties"),
  },
  handler: async (ctx, args) => {
    const claims = await ctx.db
      .query("bountyClaims")
      .withIndex("by_agentId_and_status", (q) =>
        q.eq("agentId", args.agentId).eq("status", "active")
      )
      .collect();

    return claims.find((c) => c.bountyId === args.bountyId) ?? null;
  },
});

export const updateForkInfo = internalMutation({
  args: {
    claimId: v.id("bountyClaims"),
    forkRepositoryUrl: v.string(),
    forkAccessToken: v.string(),
    forkTokenExpiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.claimId, {
      forkRepositoryUrl: args.forkRepositoryUrl,
      forkAccessToken: args.forkAccessToken,
      forkTokenExpiresAt: args.forkTokenExpiresAt,
    });
  },
});

export const markCompleted = internalMutation({
  args: { claimId: v.id("bountyClaims") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.claimId, { status: "completed" });
  },
});
