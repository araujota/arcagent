import { internalMutation, internalQuery, internalAction } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { resolveGitHubTokenForRepo } from "./lib/githubApp";

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

    // SECURITY (P0-1): Prevent claiming unfunded Stripe bounties
    if (bounty.paymentMethod === "stripe" && bounty.escrowStatus !== "funded") {
      throw new Error("Cannot claim: bounty escrow is not funded");
    }

    // SECURITY: Anti-sybil — agents cannot claim their own bounties
    if (bounty.creatorId === args.agentId) {
      throw new Error("You cannot claim your own bounty");
    }

    // Tier enforcement
    if (bounty.requiredTier) {
      const TIER_RANK: Record<string, number> = { S: 5, A: 4, B: 3, C: 2, D: 1, unranked: 0 };
      const agentStats = await ctx.db
        .query("agentStats")
        .withIndex("by_agentId", (q) => q.eq("agentId", args.agentId))
        .unique();
      const required = TIER_RANK[bounty.requiredTier];
      const actual = TIER_RANK[agentStats?.tier ?? "unranked"];
      if (actual < required) {
        throw new Error(
          `This bounty requires tier ${bounty.requiredTier} or above. Your current tier: ${agentStats?.tier ?? "unranked"}`
        );
      }
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

    // Provision dev workspace — proceed regardless of repoConn status.
    // The VM can clone the repo directly using the URL + commitSha from the bounty.
    const repoConn = await ctx.db
      .query("repoConnections")
      .withIndex("by_bountyId", (q) => q.eq("bountyId", args.bountyId))
      .first();

    const repositoryUrl = repoConn?.repositoryUrl ?? bounty.repositoryUrl ?? "";
    if (repositoryUrl) {
      if (repoConn && repoConn.status !== "ready") {
        console.warn(
          `[bountyClaims] Provisioning workspace while repo status is "${repoConn.status}" for bounty ${args.bountyId}`
        );
      }
      const workspaceId = crypto.randomUUID();
      const wsDocId = await ctx.db.insert("devWorkspaces", {
        claimId,
        bountyId: args.bountyId,
        agentId: args.agentId,
        workspaceId,
        workerHost: "",
        status: "provisioning",
        language: repoConn?.languages?.[0] ?? "typescript",
        repositoryUrl,
        baseCommitSha: repoConn?.commitSha ?? "",
        createdAt: Date.now(),
        expiresAt,
      });
      await ctx.scheduler.runAfter(0, internal.devWorkspaces.provisionWorkspace, {
        workspaceDocId: wsDocId,
        workspaceId,
        claimId,
        bountyId: args.bountyId,
        agentId: args.agentId,
        repositoryUrl,
        commitSha: repoConn?.commitSha ?? "",
        language: repoConn?.languages?.[0] ?? "typescript",
        expiresAt,
      });
    }

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

    // SECURITY (P1-3): Schedule branch cleanup on release
    if (claim.featureBranchName && claim.featureBranchRepo) {
      await ctx.scheduler.runAfter(0, internal.bountyClaims.cleanupBranch, {
        featureBranchRepo: claim.featureBranchRepo,
        featureBranchName: claim.featureBranchName,
      });
    }

    // Destroy dev workspace on release
    const ws = await ctx.db
      .query("devWorkspaces")
      .withIndex("by_claimId", (q) => q.eq("claimId", args.claimId))
      .first();
    if (ws && ws.status !== "destroyed") {
      await ctx.scheduler.runAfter(0, internal.devWorkspaces.destroyWorkspace, {
        workspaceDocId: ws._id,
        workspaceId: ws.workspaceId,
        workerHost: ws.workerHost,
        reason: "claim_released",
      });
    }
  },
});

export const ensureWorkspaceForActiveClaim = internalMutation({
  args: {
    claimId: v.id("bountyClaims"),
  },
  handler: async (ctx, args) => {
    const claim = await ctx.db.get(args.claimId);
    if (!claim) throw new Error("Claim not found");
    if (claim.status !== "active") throw new Error("Claim is not active");

    const existingWorkspace = await ctx.db
      .query("devWorkspaces")
      .withIndex("by_claimId", (q) => q.eq("claimId", args.claimId))
      .first();

    if (existingWorkspace) {
      return {
        created: false,
        workspaceId: existingWorkspace.workspaceId,
        status: existingWorkspace.status,
      };
    }

    const bounty = await ctx.db.get(claim.bountyId);
    if (!bounty) throw new Error("Bounty not found");

    const repoConn = await ctx.db
      .query("repoConnections")
      .withIndex("by_bountyId", (q) => q.eq("bountyId", claim.bountyId))
      .first();

    const repositoryUrl = repoConn?.repositoryUrl ?? bounty.repositoryUrl ?? "";
    if (!repositoryUrl) {
      throw new Error("Cannot create workspace: repository URL is not configured for this bounty");
    }

    const workspaceId = crypto.randomUUID();
    const wsDocId = await ctx.db.insert("devWorkspaces", {
      claimId: claim._id,
      bountyId: claim.bountyId,
      agentId: claim.agentId,
      workspaceId,
      workerHost: "",
      status: "provisioning",
      language: repoConn?.languages?.[0] ?? "typescript",
      repositoryUrl,
      baseCommitSha: repoConn?.commitSha ?? "",
      createdAt: Date.now(),
      expiresAt: claim.expiresAt,
    });

    await ctx.scheduler.runAfter(0, internal.devWorkspaces.provisionWorkspace, {
      workspaceDocId: wsDocId,
      workspaceId,
      claimId: claim._id,
      bountyId: claim.bountyId,
      agentId: claim.agentId,
      repositoryUrl,
      commitSha: repoConn?.commitSha ?? "",
      language: repoConn?.languages?.[0] ?? "typescript",
      expiresAt: claim.expiresAt,
    });

    return {
      created: true,
      workspaceId,
      status: "provisioning",
    };
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

        // SECURITY (P1-3): Schedule branch cleanup
        if (claim.featureBranchName && claim.featureBranchRepo) {
          await ctx.scheduler.runAfter(0, internal.bountyClaims.cleanupBranch, {
            featureBranchRepo: claim.featureBranchRepo,
            featureBranchName: claim.featureBranchName,
          });
        }

        // Destroy dev workspace on expiry
        const ws = await ctx.db
          .query("devWorkspaces")
          .withIndex("by_claimId", (q) => q.eq("claimId", claim._id))
          .first();
        if (ws && ws.status !== "destroyed") {
          await ctx.scheduler.runAfter(0, internal.devWorkspaces.destroyWorkspace, {
            workspaceDocId: ws._id,
            workspaceId: ws.workspaceId,
            workerHost: ws.workerHost,
            reason: "claim_expired",
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

export const getByIdInternal = internalQuery({
  args: { claimId: v.id("bountyClaims") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.claimId);
  },
});

export const getByAgentAndBountyAnyStatus = internalQuery({
  args: {
    agentId: v.id("users"),
    bountyId: v.id("bounties"),
  },
  handler: async (ctx, args) => {
    const claims = await ctx.db
      .query("bountyClaims")
      .withIndex("by_agentId", (q) => q.eq("agentId", args.agentId))
      .collect();

    return claims.find((c) => c.bountyId === args.bountyId) ?? null;
  },
});

export const updateBranchInfo = internalMutation({
  args: {
    claimId: v.id("bountyClaims"),
    featureBranchName: v.string(),
    featureBranchRepo: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.claimId, {
      featureBranchName: args.featureBranchName,
      featureBranchRepo: args.featureBranchRepo,
    });
  },
});

export const markCompleted = internalMutation({
  args: { claimId: v.id("bountyClaims") },
  handler: async (ctx, args) => {
    const claim = await ctx.db.get(args.claimId);
    await ctx.db.patch(args.claimId, { status: "completed" });

    // SECURITY (P1-3): Schedule branch cleanup on completion
    if (claim?.featureBranchName && claim?.featureBranchRepo) {
      await ctx.scheduler.runAfter(0, internal.bountyClaims.cleanupBranch, {
        featureBranchRepo: claim.featureBranchRepo,
        featureBranchName: claim.featureBranchName,
      });
    }

    // Destroy dev workspace on completion
    if (claim) {
      const ws = await ctx.db
        .query("devWorkspaces")
        .withIndex("by_claimId", (q) => q.eq("claimId", args.claimId))
        .first();
      if (ws && ws.status !== "destroyed") {
        await ctx.scheduler.runAfter(0, internal.devWorkspaces.destroyWorkspace, {
          workspaceDocId: ws._id,
          workspaceId: ws.workspaceId,
          workerHost: ws.workerHost,
          reason: "verification_complete",
        });
      }
    }
  },
});

/**
 * Clean up a feature branch from the source repository.
 * Called after claim expiry, release, or completion.
 */
export const cleanupBranch = internalAction({
  args: {
    featureBranchRepo: v.string(),
    featureBranchName: v.string(),
    retryCount: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const retryCount = args.retryCount ?? 0;
    const MAX_RETRIES = 3;
    const [owner, repo] = args.featureBranchRepo.split("/");
    if (!owner || !repo) {
      console.warn(`[cleanupBranch] Invalid featureBranchRepo format: ${args.featureBranchRepo}`);
      return;
    }

    const repoUrl = `https://github.com/${owner}/${repo}`;
    let botToken = process.env.GITHUB_BOT_TOKEN;
    try {
      const repoConnection = await ctx.runQuery(internal.repoConnections.getByOwnerRepo, {
        owner,
        repo,
      });
      const tokenResult = await resolveGitHubTokenForRepo({
        repositoryUrl: repoUrl,
        preferredInstallationId: repoConnection?.githubInstallationId,
        writeAccess: true,
      });
      if (
        repoConnection &&
        tokenResult &&
        (tokenResult.installationId !== repoConnection.githubInstallationId ||
          tokenResult.accountLogin !== repoConnection.githubInstallationAccountLogin)
      ) {
        await ctx.runMutation(internal.repoConnections.updateGitHubInstallation, {
          repoConnectionId: repoConnection._id,
          githubInstallationId: tokenResult.installationId,
          githubInstallationAccountLogin: tokenResult.accountLogin,
        });
      }
      botToken = tokenResult?.token ?? botToken;
    } catch (err) {
      console.error(
        `[cleanupBranch] Failed to mint GitHub installation token for ${owner}/${repo}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    if (!botToken) {
      console.warn(
        "[cleanupBranch] No GitHub installation token or GITHUB_BOT_TOKEN available, skipping branch cleanup",
      );
      return;
    }

    try {
      const res = await fetch(
        `https://api.github.com/repos/${args.featureBranchRepo}/git/refs/heads/${args.featureBranchName}`,
        {
          method: "DELETE",
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${botToken}`,
            "X-GitHub-Api-Version": "2022-11-28",
          },
        },
      );

      if (res.ok || res.status === 404 || res.status === 422) {
        console.log(`[cleanupBranch] Deleted branch ${args.featureBranchName} on ${args.featureBranchRepo}`);
      } else {
        const body = await res.text().catch(() => "");
        console.error(
          `[cleanupBranch] Failed to delete branch ${args.featureBranchName} on ${args.featureBranchRepo}: ${res.status} ${body.slice(0, 200)}`
        );
        // Schedule retry with exponential backoff
        if (retryCount < MAX_RETRIES) {
          const delayMs = Math.pow(2, retryCount) * 60_000; // 1min, 2min, 4min
          await ctx.scheduler.runAfter(delayMs, internal.bountyClaims.cleanupBranch, {
            featureBranchRepo: args.featureBranchRepo,
            featureBranchName: args.featureBranchName,
            retryCount: retryCount + 1,
          });
          console.log(`[cleanupBranch] Scheduled retry ${retryCount + 1}/${MAX_RETRIES} in ${delayMs / 1000}s`);
        }
      }
    } catch (err) {
      console.error(
        `[cleanupBranch] Error deleting branch ${args.featureBranchName} on ${args.featureBranchRepo}:`,
        err instanceof Error ? err.message : String(err)
      );
      // Schedule retry with exponential backoff
      if (retryCount < MAX_RETRIES) {
        const delayMs = Math.pow(2, retryCount) * 60_000;
        await ctx.scheduler.runAfter(delayMs, internal.bountyClaims.cleanupBranch, {
          featureBranchRepo: args.featureBranchRepo,
          featureBranchName: args.featureBranchName,
          retryCount: retryCount + 1,
        });
        console.log(`[cleanupBranch] Scheduled retry ${retryCount + 1}/${MAX_RETRIES} in ${delayMs / 1000}s`);
      }
    }
  },
});
