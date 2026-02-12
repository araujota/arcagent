import { internalMutation, internalQuery, internalAction } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";

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

    const claimId = await ctx.db.insert("bountyClaims", {
      bountyId: args.bountyId,
      agentId: args.agentId,
      status: "active",
      claimedAt: now,
      expiresAt,
    });

    // Transition bounty to in_progress (exclusive lock)
    await ctx.db.patch(args.bountyId, { status: "in_progress" });

    const agent = await ctx.db.get(args.agentId);
    await ctx.scheduler.runAfter(0, internal.activityFeed.record, {
      type: "bounty_claimed",
      bountyId: args.bountyId,
      bountyTitle: bounty.title,
      actorName: agent?.name ?? "An agent",
    });

    return claimId;
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

    // Revert bounty to active
    await ctx.db.patch(claim.bountyId, { status: "active" });

    // SECURITY (P1-3): Schedule fork cleanup on release
    if (claim.forkRepositoryUrl) {
      await ctx.scheduler.runAfter(0, internal.bountyClaims.cleanupFork, {
        forkRepositoryUrl: claim.forkRepositoryUrl,
      });
    }
  },
});

export const expireStale = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const EXTENSION_MS = 30 * 60 * 1000; // 30 minutes

    // Use index to only fetch claims with expiresAt before now
    const expiredClaims = await ctx.db
      .query("bountyClaims")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
      .collect();

    let expiredCount = 0;
    let extendedCount = 0;
    for (const claim of expiredClaims) {
      if (claim.status === "active") {
        // SECURITY (P1-5): Check for active verifications before expiring.
        // If a verification is pending/running, extend the claim instead of
        // expiring it — prevents race condition with double payout.
        const activeVerifications = await ctx.db
          .query("verifications")
          .withIndex("by_bountyId", (q) => q.eq("bountyId", claim.bountyId))
          .collect();

        const hasRunningVerification = activeVerifications.some(
          (v) => v.status === "pending" || v.status === "running"
        );

        if (hasRunningVerification) {
          await ctx.db.patch(claim._id, { expiresAt: now + EXTENSION_MS });
          extendedCount++;
          continue;
        }

        await ctx.db.patch(claim._id, { status: "expired" });
        // Revert bounty to active
        await ctx.db.patch(claim.bountyId, { status: "active" });
        expiredCount++;

        // SECURITY (P1-3): Schedule fork cleanup
        if (claim.forkRepositoryUrl) {
          await ctx.scheduler.runAfter(0, internal.bountyClaims.cleanupFork, {
            forkRepositoryUrl: claim.forkRepositoryUrl,
          });
        }
      }
    }

    if (expiredCount > 0 || extendedCount > 0) {
      console.log(
        `Expired ${expiredCount} stale bounty claims, extended ${extendedCount} with active verifications`
      );
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
    const claim = await ctx.db.get(args.claimId);
    await ctx.db.patch(args.claimId, { status: "completed" });

    // SECURITY (P1-3): Schedule fork cleanup on completion
    if (claim?.forkRepositoryUrl) {
      await ctx.scheduler.runAfter(0, internal.bountyClaims.cleanupFork, {
        forkRepositoryUrl: claim.forkRepositoryUrl,
      });
    }
  },
});

/**
 * Clean up a fork repository from the GitHub mirror org.
 * Called after claim expiry, release, or completion.
 */
export const cleanupFork = internalAction({
  args: {
    forkRepositoryUrl: v.string(),
  },
  handler: async (_ctx, args) => {
    const botToken = process.env.GITHUB_BOT_TOKEN;
    if (!botToken) {
      console.warn("[cleanupFork] GITHUB_BOT_TOKEN not configured, skipping fork cleanup");
      return;
    }

    // Extract owner/repo from URL: https://github.com/owner/repo
    const match = args.forkRepositoryUrl.match(
      /github\.com\/([^/]+)\/([^/]+)/
    );
    if (!match) {
      console.warn(`[cleanupFork] Could not parse fork URL: ${args.forkRepositoryUrl}`);
      return;
    }

    const [, owner, repo] = match;
    const fullName = `${owner}/${repo!.replace(/\.git$/, "")}`;

    try {
      const res = await fetch(`https://api.github.com/repos/${fullName}`, {
        method: "DELETE",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${botToken}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });

      if (res.ok || res.status === 404) {
        console.log(`[cleanupFork] Deleted fork ${fullName}`);
      } else {
        const body = await res.text().catch(() => "");
        console.error(
          `[cleanupFork] Failed to delete fork ${fullName}: ${res.status} ${body.slice(0, 200)}`
        );
      }
    } catch (err) {
      console.error(
        `[cleanupFork] Error deleting fork ${fullName}:`,
        err instanceof Error ? err.message : String(err)
      );
    }
  },
});
