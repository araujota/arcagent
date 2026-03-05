import { internalMutation, internalQuery, internalAction } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { fetchWithRetry } from "./lib/httpRetry";
import { requiresCloneAuthToken, resolveRepoAuth } from "./lib/repoAuth";
import { detectProvider } from "./lib/repoProviders";

type WorkspaceRepoConnection = {
  _id: string;
  githubInstallationId?: number;
  githubInstallationAccountLogin?: string;
} | null;

type WorkspaceBounty = {
  creatorId: string;
} | null;

type WorkspaceDispatchContext = {
  runMutation: (mutation: unknown, args: Record<string, unknown>) => Promise<unknown>;
  runQuery: (query: unknown, args: Record<string, unknown>) => Promise<unknown>;
};

function formatWorkspaceAuthError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function resolveWorkspaceRepoAuth(params: {
  ctx: WorkspaceDispatchContext;
  repositoryUrl: string;
  repoConnection: WorkspaceRepoConnection;
  bounty: WorkspaceBounty;
}): Promise<{ repoAuthToken?: string; repoAuthUsername?: string }> {
  const providerName = detectProvider(params.repositoryUrl);
  const providerAuthConnection =
    providerName && providerName !== "github" && params.bounty
      ? await params.ctx.runQuery(internal.providerConnections.getActiveAuthByUserAndProviderInternal, {
          userId: params.bounty.creatorId,
          provider: providerName,
        }) as { accessToken?: string } | null
      : null;

  try {
    const repoAuthResult = await resolveRepoAuth({
      repositoryUrl: params.repositoryUrl,
      preferredGitHubInstallationId: params.repoConnection?.githubInstallationId,
      writeAccess: false,
      providerToken: providerAuthConnection?.accessToken,
    });
    if (
      params.repoConnection &&
      repoAuthResult?.installationId &&
      (repoAuthResult.installationId !== params.repoConnection.githubInstallationId ||
        repoAuthResult.accountLogin !== params.repoConnection.githubInstallationAccountLogin)
    ) {
      await params.ctx.runMutation(internal.repoConnections.updateGitHubInstallation, {
        repoConnectionId: params.repoConnection._id,
        githubInstallationId: repoAuthResult.installationId,
        githubInstallationAccountLogin: repoAuthResult.accountLogin,
      });
    }

    return {
      repoAuthToken: repoAuthResult?.repoAuthToken,
      repoAuthUsername: repoAuthResult?.repoAuthUsername,
    };
  } catch (error) {
    console.error(
      `[devWorkspaces] Failed to resolve repository auth token: ${formatWorkspaceAuthError(error)}`,
    );
    return {};
  }
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export const create = internalMutation({
  args: {
    claimId: v.id("bountyClaims"),
    bountyId: v.id("bounties"),
    agentId: v.id("users"),
    workspaceId: v.string(),
    workerHost: v.string(),
    language: v.string(),
    repositoryUrl: v.string(),
    baseCommitSha: v.string(),
    expiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("devWorkspaces", {
      claimId: args.claimId,
      bountyId: args.bountyId,
      agentId: args.agentId,
      workspaceId: args.workspaceId,
      workerHost: args.workerHost,
      status: "provisioning",
      language: args.language,
      repositoryUrl: args.repositoryUrl,
      baseCommitSha: args.baseCommitSha,
      createdAt: Date.now(),
      expiresAt: args.expiresAt,
    });
  },
});

export const updateStatus = internalMutation({
  args: {
    workspaceId: v.string(),
    status: v.union(
      v.literal("provisioning"),
      v.literal("ready"),
      v.literal("error"),
      v.literal("destroyed"),
    ),
    vmId: v.optional(v.string()),
    workerHost: v.optional(v.string()),
    attemptWorkerId: v.optional(v.id("attemptWorkers")),
    attemptMode: v.optional(v.union(v.literal("shared_worker"), v.literal("dedicated_attempt_vm"))),
    attemptLaunchMs: v.optional(v.number()),
    attemptReadyMs: v.optional(v.number()),
    errorMessage: v.optional(v.string()),
    readyAt: v.optional(v.number()),
    destroyedAt: v.optional(v.number()),
    destroyReason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const ws = await ctx.db
      .query("devWorkspaces")
      .withIndex("by_workspaceId", (q) => q.eq("workspaceId", args.workspaceId))
      .first();

    if (!ws) throw new Error(`Workspace not found: ${args.workspaceId}`);

    const updates: Record<string, unknown> = { status: args.status };
    if (args.vmId !== undefined) updates.vmId = args.vmId;
    if (args.workerHost !== undefined) updates.workerHost = args.workerHost;
    if (args.attemptWorkerId !== undefined) updates.attemptWorkerId = args.attemptWorkerId;
    if (args.attemptMode !== undefined) updates.attemptMode = args.attemptMode;
    if (args.attemptLaunchMs !== undefined) updates.attemptLaunchMs = args.attemptLaunchMs;
    if (args.attemptReadyMs !== undefined) updates.attemptReadyMs = args.attemptReadyMs;
    if (args.errorMessage !== undefined) updates.errorMessage = args.errorMessage;
    if (args.readyAt !== undefined) updates.readyAt = args.readyAt;
    if (args.destroyedAt !== undefined) updates.destroyedAt = args.destroyedAt;
    if (args.destroyReason !== undefined) updates.destroyReason = args.destroyReason;

    await ctx.db.patch(ws._id, updates);
  },
});

export const markDestroyed = internalMutation({
  args: {
    workspaceId: v.string(),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const ws = await ctx.db
      .query("devWorkspaces")
      .withIndex("by_workspaceId", (q) => q.eq("workspaceId", args.workspaceId))
      .first();

    if (!ws) return;
    if (ws.status === "destroyed") return;

    await ctx.db.patch(ws._id, {
      status: "destroyed",
      destroyedAt: Date.now(),
      destroyReason: args.reason,
    });
  },
});

export const updateExpiresAt = internalMutation({
  args: {
    workspaceId: v.string(),
    expiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    const ws = await ctx.db
      .query("devWorkspaces")
      .withIndex("by_workspaceId", (q) => q.eq("workspaceId", args.workspaceId))
      .first();

    if (!ws) return;
    await ctx.db.patch(ws._id, { expiresAt: args.expiresAt });
  },
});

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const getByClaimId = internalQuery({
  args: { claimId: v.id("bountyClaims") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("devWorkspaces")
      .withIndex("by_claimId", (q) => q.eq("claimId", args.claimId))
      .first();
  },
});

export const getByWorkspaceId = internalQuery({
  args: { workspaceId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("devWorkspaces")
      .withIndex("by_workspaceId", (q) => q.eq("workspaceId", args.workspaceId))
      .first();
  },
});

export const getActiveByAgent = internalQuery({
  args: { agentId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("devWorkspaces")
      .withIndex("by_agentId_and_status", (q) =>
        q.eq("agentId", args.agentId).eq("status", "ready"),
      )
      .first();
  },
});

export const getActiveByAgentAndBounty = internalQuery({
  args: {
    agentId: v.id("users"),
    bountyId: v.id("bounties"),
  },
  handler: async (ctx, args) => {
    const workspaces = await ctx.db
      .query("devWorkspaces")
      .withIndex("by_agentId_and_status", (q) =>
        q.eq("agentId", args.agentId).eq("status", "ready"),
      )
      .collect();

    return workspaces.find((ws) => ws.bountyId === args.bountyId) ?? null;
  },
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Provision a dev workspace by calling the worker API.
 * Scheduled immediately after claim creation.
 */
export const provisionWorkspace = internalAction({
  args: {
    workspaceDocId: v.id("devWorkspaces"),
    workspaceId: v.string(),
    claimId: v.id("bountyClaims"),
    bountyId: v.id("bounties"),
    agentId: v.id("users"),
    repositoryUrl: v.string(),
    commitSha: v.string(),
    language: v.string(),
    expiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    try {
      const workerUrl = process.env.WORKER_API_URL;
      const workerSecret = process.env.WORKER_SHARED_SECRET;
      if (!workerUrl || !workerSecret) {
        await ctx.runMutation(internal.devWorkspaces.updateStatus, {
          workspaceId: args.workspaceId,
          status: "error",
          errorMessage:
            "WORKER_API_URL and WORKER_SHARED_SECRET must be configured for workspace provisioning",
        });
        return;
      }

      const repoConnection = await ctx.runQuery(internal.repoConnections.getByBountyIdInternal, {
        bountyId: args.bountyId,
      });
      const bounty = await ctx.runQuery(internal.bounties.getByIdInternal, {
        bountyId: args.bountyId,
      });
      const { repoAuthToken, repoAuthUsername } = await resolveWorkspaceRepoAuth({
        ctx,
        repositoryUrl: args.repositoryUrl,
        repoConnection,
        bounty,
      });

      const repoContextFiles = process.env.ENABLE_REPO_CONTEXT_FILES === "true"
        ? await ctx.runQuery(internal.repoContextFiles.listReadyForRepositoryUrlInternal, {
            repositoryUrl: args.repositoryUrl,
          })
        : [];

      if (requiresCloneAuthToken(args.repositoryUrl) && !repoAuthToken) {
        throw new Error(
          "GitHub installation token is required for workspace provisioning. Install/repair the GitHub App for this repository.",
        );
      }

      const response = await fetchWithRetry(`${workerUrl}/api/workspace/provision`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${workerSecret}`,
        },
        body: JSON.stringify({
          workspaceId: args.workspaceId,
          claimId: args.claimId,
          bountyId: args.bountyId,
          agentId: args.agentId,
          repoUrl: args.repositoryUrl,
          repoAuthToken,
          repoAuthUsername,
          commitSha: args.commitSha,
          language: args.language,
          expiresAt: args.expiresAt,
          repoContextFiles: repoContextFiles.map((row) => ({
            name: row.filenameSafe,
            content: row.extractedText,
            sourceFileId: row._id,
          })),
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Worker API error: ${response.status} - ${errorText.slice(0, 300)}`);
      }

      const result = await response.json() as {
        vmId: string;
        workerHost: string;
        status: string;
      };

      const resolvedStatus = result.status === "error" ? "error" : "ready";
      await ctx.runMutation(internal.devWorkspaces.updateStatus, {
        workspaceId: args.workspaceId,
        status: resolvedStatus as "ready" | "error",
        vmId: result.vmId,
        workerHost: result.workerHost,
        readyAt: resolvedStatus === "ready" ? Date.now() : undefined,
        errorMessage: resolvedStatus === "error" ? "Worker reported error status" : undefined,
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error provisioning workspace";
      console.error(`[devWorkspaces] Provision failed: ${errorMessage}`);

      await ctx.runMutation(internal.devWorkspaces.updateStatus, {
        workspaceId: args.workspaceId,
        status: "error",
        errorMessage,
      });
    }
  },
});

/**
 * Destroy a dev workspace by calling the worker API.
 */
export const destroyWorkspace = internalAction({
  args: {
    workspaceDocId: v.id("devWorkspaces"),
    workspaceId: v.string(),
    workerHost: v.string(),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const workerSecret = process.env.WORKER_SHARED_SECRET;

    // Mark as destroyed in Convex first
    await ctx.runMutation(internal.devWorkspaces.markDestroyed, {
      workspaceId: args.workspaceId,
      reason: args.reason,
    });

    // Best-effort call to shared worker to tear down VM
    if (args.workerHost && workerSecret) {
      try {
        await fetch(`${args.workerHost}/api/workspace/destroy`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${workerSecret}`,
          },
          body: JSON.stringify({
            workspaceId: args.workspaceId,
            reason: args.reason,
          }),
        });
      } catch (err) {
        console.error(
          `[devWorkspaces] Failed to destroy workspace on worker: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  },
});

/**
 * Clean up orphaned workspaces.
 * Finds workspaces where associated claims are expired/released but workspace is still ready.
 */
export const cleanupOrphaned = internalMutation({
  args: {},
  handler: async (ctx) => {
    const readyWorkspaces = await ctx.db
      .query("devWorkspaces")
      .withIndex("by_status", (q) => q.eq("status", "ready"))
      .collect();

    let cleanedCount = 0;
    for (const ws of readyWorkspaces) {
      const claim = await ctx.db.get(ws.claimId);

      // Destroy if claim is gone, expired, released, or completed
      if (claim?.status !== "active") {
        await ctx.scheduler.runAfter(0, internal.devWorkspaces.destroyWorkspace, {
          workspaceDocId: ws._id,
          workspaceId: ws.workspaceId,
          workerHost: ws.workerHost,
          reason: claim ? `claim_${claim.status}` : "claim_deleted",
        });
        cleanedCount++;
      }

      // Also destroy if past TTL
      if (ws.expiresAt < Date.now()) {
        await ctx.scheduler.runAfter(0, internal.devWorkspaces.destroyWorkspace, {
          workspaceDocId: ws._id,
          workspaceId: ws.workspaceId,
          workerHost: ws.workerHost,
          reason: "ttl_expired",
        });
        cleanedCount++;
      }
    }

    // Clean up workspaces stuck in "provisioning" for >10 minutes
    const provisioningWorkspaces = await ctx.db
      .query("devWorkspaces")
      .withIndex("by_status", (q) => q.eq("status", "provisioning"))
      .collect();

    const now = Date.now();
    for (const ws of provisioningWorkspaces) {
      if (ws.createdAt < now - 10 * 60 * 1000) {
        await ctx.scheduler.runAfter(0, internal.devWorkspaces.destroyWorkspace, {
          workspaceDocId: ws._id,
          workspaceId: ws.workspaceId,
          workerHost: ws.workerHost,
          reason: "stuck_provisioning",
        });
        cleanedCount++;
      }
    }

    // Clean up workspaces in "error" state for >5 minutes
    const errorWorkspaces = await ctx.db
      .query("devWorkspaces")
      .withIndex("by_status", (q) => q.eq("status", "error"))
      .collect();

    for (const ws of errorWorkspaces) {
      if (ws.createdAt < now - 5 * 60 * 1000) {
        await ctx.scheduler.runAfter(0, internal.devWorkspaces.destroyWorkspace, {
          workspaceDocId: ws._id,
          workspaceId: ws.workspaceId,
          workerHost: ws.workerHost,
          reason: "error_cleanup",
        });
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      console.log(`[devWorkspaces] Cleaned up ${cleanedCount} orphaned workspaces`);
    }
  },
});
