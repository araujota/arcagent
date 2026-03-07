import { query, mutation, internalMutation, internalQuery, internalAction, action } from "./_generated/server";
import { v } from "convex/values";
import { getCurrentUser, requireAuth, requireBountyAccess } from "./lib/utils";
import { internal } from "./_generated/api";
import { detectProvider, getRepoProvider, repoProviderValidator, type RepoProvider } from "./lib/repoProviders";
import {
  findGitHubInstallationForRepo,
  getGitHubAppInstallUrl,
  isGitHubAppConfigured,
  parseGitHubRepoUrlSafe,
} from "./lib/githubApp";
import { resolveRepoAuth } from "./lib/repoAuth";

type RepoProviderName = "github" | "gitlab" | "bitbucket";

function providerCapabilities(_provider: RepoProviderName) {
  return {
    supportsWebhookPush: true,
    supportsNativePr: true,
    supportsAutoBranchWrite: true,
  };
}

function redactConnectionForClient<T extends Record<string, unknown>>(conn: T): T {
  const {
    tokenRef: _tokenRef,
    oauthAccessToken: _oauthAccessToken,
    oauthRefreshToken: _oauthRefreshToken,
    ...safe
  } = conn as T & {
    tokenRef?: string;
    oauthAccessToken?: string;
    oauthRefreshToken?: string;
  };
  return safe as T;
}

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
      return { ...redactConnectionForClient(rest), repositoryUrl: "[redacted]" };
    }

    return redactConnectionForClient(conn);
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
    githubInstallationId: v.optional(v.number()),
    githubInstallationAccountLogin: v.optional(v.string()),
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
    const detectedProvider = detectProvider(args.repositoryUrl);
    if (!detectedProvider) {
      throw new Error(
        "Unsupported repository URL. Please use a GitHub, GitLab, or Bitbucket URL."
      );
    }
    if (detectedProvider === "github" && !args.githubInstallationId) {
      throw new Error(
        "GitHub App installation is required for this repository. Install the Arcagent GitHub App on the repo or org, then try again."
      );
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
      provider: detectedProvider,
      owner: "",
      repo: "",
      defaultBranch: "main",
      commitSha: "",
      webhookStatus: "unconfigured",
      authMode: detectedProvider === "github" ? "github_app" : "none",
      capabilities: providerCapabilities(detectedProvider),
      status: "pending",
      githubInstallationId: args.githubInstallationId,
      githubInstallationAccountLogin: args.githubInstallationAccountLogin,
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
    githubInstallationId: v.optional(v.number()),
    githubInstallationAccountLogin: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const provider = detectProvider(args.repositoryUrl) ?? "github";
    if (provider === "github" && !args.githubInstallationId) {
      throw new Error(
        "GitHub App installation is required for this repository. Install the Arcagent GitHub App on the repo or org, then try again."
      );
    }
    const id = await ctx.db.insert("repoConnections", {
      bountyId: args.bountyId,
      repositoryUrl: args.repositoryUrl,
      provider,
      owner: "",
      repo: "",
      defaultBranch: "main",
      commitSha: "",
      webhookStatus: "unconfigured",
      authMode: provider === "github" ? "github_app" : "none",
      capabilities: providerCapabilities(provider),
      status: "pending",
      githubInstallationId: args.githubInstallationId,
      githubInstallationAccountLogin: args.githubInstallationAccountLogin,
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
    provider: v.optional(repoProviderValidator),
  },
  handler: async (ctx, args) => {
    const updates: Record<string, unknown> = {
      owner: args.owner,
      repo: args.repo,
      defaultBranch: args.defaultBranch,
    };
    if (args.provider) {
      updates.provider = args.provider;
    }
    await ctx.db.patch(args.repoConnectionId, updates);
  },
});

export const updateGitHubInstallation = internalMutation({
  args: {
    repoConnectionId: v.id("repoConnections"),
    githubInstallationId: v.optional(v.number()),
    githubInstallationAccountLogin: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.repoConnectionId, {
      githubInstallationId: args.githubInstallationId,
      githubInstallationAccountLogin: args.githubInstallationAccountLogin,
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
          provider: repoConnection.provider,
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

type RepoConnectionForUpdateCheck = {
  _id: unknown;
  bountyId: unknown;
  provider?: RepoProviderName;
  owner?: string;
  repo?: string;
  trackedBranch?: string;
  defaultBranch: string;
  githubInstallationId?: number;
  githubInstallationAccountLogin?: string;
  commitSha?: string;
};

function buildRepositoryUrl(provider: RepoProviderName, owner: string, repo: string): string {
  switch (provider) {
    case "github":
      return `https://github.com/${owner}/${repo}`;
    case "gitlab":
      return `https://gitlab.com/${owner}/${repo}`;
    case "bitbucket":
      return `https://bitbucket.org/${owner}/${repo}`;
  }
}

async function resolveProviderTokenForUpdateCheck(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  provider: RepoProviderName,
  bountyId: unknown,
): Promise<string | undefined> {
  if (provider === "github") return undefined;
  const bounty = await ctx.runQuery(internal.bounties.getByIdInternal, {
    bountyId,
  });
  if (!bounty) return undefined;
  const providerAuthConnection = await ctx.runQuery(
    internal.providerConnections.getActiveAuthByUserAndProviderInternal,
    {
      userId: bounty.creatorId,
      provider,
    },
  );
  return providerAuthConnection?.accessToken;
}

function buildProviderForUpdateCheck(
  providerName: RepoProviderName,
  auth: {
    provider: RepoProviderName;
    repoAuthToken?: string;
    repoAuthUsername?: string;
  },
): RepoProvider {
  return getRepoProvider(providerName, {
    githubToken: auth.provider === "github" ? auth.repoAuthToken : undefined,
    gitlabToken: auth.provider === "gitlab" ? auth.repoAuthToken : undefined,
    bitbucketCredentials:
      auth.provider === "bitbucket"
        ? {
            account: auth.repoAuthUsername,
            token: auth.repoAuthToken,
          }
        : undefined,
  });
}

function assertGitHubAuthForUpdateCheck(provider: RepoProviderName, repoAuthToken?: string): void {
  if (provider === "github" && !repoAuthToken) {
    throw new Error(
      "GitHub installation token is required for repository update checks. Install/repair the GitHub App for this repository.",
    );
  }
}

async function maybeSyncInstallationForUpdateCheck(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  connection: RepoConnectionForUpdateCheck,
  auth: {
    installationId?: number;
    accountLogin?: string;
  },
): Promise<void> {
  if (
    !auth.installationId ||
    (auth.installationId === connection.githubInstallationId &&
      auth.accountLogin === connection.githubInstallationAccountLogin)
  ) {
    return;
  }
  await ctx.runMutation(internal.repoConnections.updateGitHubInstallation, {
    repoConnectionId: connection._id,
    githubInstallationId: auth.installationId,
    githubInstallationAccountLogin: auth.accountLogin,
  });
}

async function checkConnectionForUpdates(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  connection: RepoConnectionForUpdateCheck,
): Promise<void> {
  if (!connection.owner || !connection.repo) return;

  const providerName = connection.provider ?? "github";
  const branch = connection.trackedBranch || connection.defaultBranch;
  const repoUrl = buildRepositoryUrl(providerName, connection.owner, connection.repo);
  const providerToken = await resolveProviderTokenForUpdateCheck(ctx, providerName, connection.bountyId);
  const auth = await resolveRepoAuth({
    repositoryUrl: repoUrl,
    preferredGitHubInstallationId: connection.githubInstallationId,
    writeAccess: false,
    providerToken,
  });
  assertGitHubAuthForUpdateCheck(providerName, auth.repoAuthToken);

  const provider = buildProviderForUpdateCheck(providerName, auth);
  await maybeSyncInstallationForUpdateCheck(ctx, connection, auth);

  const headSha = await provider.fetchHeadCommitId(connection.owner, connection.repo, branch);
  if (!headSha || headSha === connection.commitSha) return;

  console.log(`[checkForUpdates] New commit on ${connection.owner}/${connection.repo}@${branch}: ${headSha}`);
  await ctx.runMutation(internal.repoConnections.triggerReIndex, {
    repoConnectionId: connection._id,
    newCommitSha: headSha,
  });
}

/**
 * Cron-driven check for tracked repos that may have new commits.
 * Polls the appropriate provider API for HEAD commit on the tracked branch.
 */
export const checkForUpdates = internalAction({
  args: {},
  handler: async (ctx) => {
    const readyConnections = await ctx.runQuery(
      internal.repoConnections.listReady
    );

    for (const conn of readyConnections) {
      try {
        await checkConnectionForUpdates(ctx, conn as RepoConnectionForUpdateCheck);
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

export const getByOwnerRepo = internalQuery({
  args: {
    owner: v.string(),
    repo: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("repoConnections")
      .withIndex("by_owner_and_repo", (q) => q.eq("owner", args.owner).eq("repo", args.repo))
      .first();
  },
});

/**
 * Return GitHub App authorization status for a repository URL.
 * Used by the web UI to show a native GitHub install/authorize step.
 */
export const getGitHubPermissionStatus = action({
  args: {
    repositoryUrl: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Authentication required");
    }

    const provider = detectProvider(args.repositoryUrl);
    if (provider !== "github") {
      return {
        provider,
        appConfigured: false,
        hasInstallation: false,
        installUrl: null,
      };
    }

    const appConfigured = isGitHubAppConfigured();
    const installUrl = getGitHubAppInstallUrl();
    if (!appConfigured) {
      return {
        provider,
        appConfigured: false,
        hasInstallation: false,
        installUrl,
      };
    }

    const parsed = parseGitHubRepoUrlSafe(args.repositoryUrl);
    if (!parsed) {
      return {
        provider,
        appConfigured: true,
        hasInstallation: false,
        installUrl,
      };
    }

    const installation = await findGitHubInstallationForRepo(parsed.owner, parsed.repo);
    return {
      provider,
      appConfigured: true,
      hasInstallation: Boolean(installation),
      installationId: installation?.installationId,
      installUrl,
    };
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
