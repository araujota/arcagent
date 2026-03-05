import { internalAction } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import {
  detectProvider,
  getRepoProvider,
  isSourceFile,
  MAX_FILE_SIZE,
  MAX_FILES,
  type RepoProvider,
  type RepoProviderName,
  type NormalizedTreeEntry,
} from "../lib/repoProviders";
import { resolveRepoAuth } from "../lib/repoAuth";

type RepoConnectionStatusRecord = {
  status?: string;
  provider?: RepoProviderName;
  githubInstallationId?: number;
  githubInstallationAccountLogin?: string;
};

type FileDataRecord = {
  filePath: string;
  sha: string;
  content: string;
  size: number;
};

function ensureProviderName(
  providerName: RepoProviderName | null | undefined,
  repositoryUrl: string,
): RepoProviderName {
  if (providerName) return providerName;
  throw new Error(
    `Unsupported repository URL: ${repositoryUrl}. Supported: github.com, gitlab.com, bitbucket.org`,
  );
}

function assertGitHubAuth(providerName: RepoProviderName, repoAuthToken?: string): void {
  if (providerName === "github" && !repoAuthToken) {
    throw new Error(
      "GitHub installation token is required for repository indexing. Install/repair the GitHub App for this repository.",
    );
  }
}

function isReindexInProgress(connection: RepoConnectionStatusRecord | null): boolean {
  return (
    connection?.status === "fetching" ||
    connection?.status === "parsing" ||
    connection?.status === "indexing"
  );
}

function buildProvider(
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

function collectSourceEntries(entries: NormalizedTreeEntry[]): NormalizedTreeEntry[] {
  const sourceEntries = entries.filter(
    (entry) =>
      entry.type === "blob" &&
      isSourceFile(entry.path) &&
      (!entry.size || entry.size <= MAX_FILE_SIZE),
  );
  if (sourceEntries.length > MAX_FILES) {
    throw new Error(
      `Repository has ${sourceEntries.length} source files, exceeding the limit of ${MAX_FILES}`,
    );
  }
  return sourceEntries;
}

function detectLanguages(sourceEntries: NormalizedTreeEntry[]): string[] {
  const langMap: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    py: "python",
    go: "go",
    rs: "rust",
    java: "java",
  };
  const languageSet = new Set<string>();
  for (const entry of sourceEntries) {
    const ext = entry.path.split(".").pop()?.toLowerCase();
    const language = ext ? langMap[ext] : undefined;
    if (language) languageSet.add(language);
  }
  return Array.from(languageSet);
}

function buildFileDataBatch(
  sourceEntries: NormalizedTreeEntry[],
  contentMap: Map<string, string>,
): FileDataRecord[] {
  const fileDataBatch: FileDataRecord[] = [];
  for (const entry of sourceEntries) {
    const content = contentMap.get(entry.id);
    if (!content) continue;
    fileDataBatch.push({
      filePath: entry.path,
      sha: entry.id,
      content,
      size: content.length,
    });
  }
  return fileDataBatch;
}

function extractFeatureFiles(fileDataBatch: FileDataRecord[]): Array<{ filePath: string; content: string }> {
  return fileDataBatch
    .filter((file) => file.filePath.endsWith(".feature"))
    .map((file) => ({ filePath: file.filePath, content: file.content }));
}

/**
 * Fetch a repository's structure and contents via the appropriate provider.
 * This is the first stage of the repo intelligence pipeline.
 *
 * Pipeline chain: fetchRepo → ensureDockerfile → parseRepo → indexRepo
 */
export const fetchRepo = internalAction({
  args: {
    repoConnectionId: v.id("repoConnections"),
    bountyId: v.id("bounties"),
    repositoryUrl: v.string(),
  },
  handler: async (ctx, args) => {
    try {
      // Guard against concurrent re-index
      const conn = await ctx.runQuery(
        internal.repoConnections.getByBountyIdInternal,
        { bountyId: args.bountyId }
      );
      if (isReindexInProgress(conn as RepoConnectionStatusRecord | null)) {
        console.log(`[fetchRepo] Re-index already in progress for bounty ${args.bountyId}, skipping`);
        return;
      }

      // Update status to fetching
      await ctx.runMutation(internal.repoConnections.updateStatus, {
        repoConnectionId: args.repoConnectionId,
        status: "fetching",
      });

      // Detect provider and create client
      const providerName = ensureProviderName(
        (conn as RepoConnectionStatusRecord | null)?.provider ?? detectProvider(args.repositoryUrl),
        args.repositoryUrl,
      );
      const bounty = await ctx.runQuery(internal.bounties.getByIdInternal, {
        bountyId: args.bountyId,
      });
      const providerAuthConnection =
        providerName !== "github" && bounty
          ? await ctx.runQuery(internal.providerConnections.getActiveAuthByUserAndProviderInternal, {
              userId: bounty.creatorId,
              provider: providerName,
            })
          : null;
      let owner = "";
      let repo = "";
      const auth = await resolveRepoAuth({
        repositoryUrl: args.repositoryUrl,
        preferredGitHubInstallationId: conn?.githubInstallationId,
        writeAccess: false,
        providerToken: providerAuthConnection?.accessToken,
      });
      assertGitHubAuth(providerName, auth.repoAuthToken);
      const provider: RepoProvider = buildProvider(providerName, auth);
      const parsed = provider.parseUrl(args.repositoryUrl);
      owner = parsed.owner;
      repo = parsed.repo;

      if (
        conn &&
        auth.installationId &&
        (auth.installationId !== conn.githubInstallationId ||
          auth.accountLogin !== conn.githubInstallationAccountLogin)
      ) {
        await ctx.runMutation(internal.repoConnections.updateGitHubInstallation, {
          repoConnectionId: args.repoConnectionId,
          githubInstallationId: auth.installationId,
          githubInstallationAccountLogin: auth.accountLogin,
        });
      }
      // Fetch repository metadata
      const metadata = await provider.fetchMetadata(owner, repo);

      // Update connection with repo info
      await ctx.runMutation(internal.repoConnections.updateMetadata, {
        repoConnectionId: args.repoConnectionId,
        owner,
        repo,
        defaultBranch: metadata.defaultBranch,
        provider: providerName,
      });

      // Fetch the full recursive file tree
      const repoTree = await provider.fetchTree(owner, repo, metadata.defaultBranch);

      if (repoTree.truncated) {
        console.warn(
          `Tree was truncated for ${owner}/${repo}. Some files may be missing.`
        );
      }

      // Filter to source files only
      const sourceEntries = collectSourceEntries(repoTree.entries);
      const languages = detectLanguages(sourceEntries);

      // Fetch file contents via provider
      const contentMap = await provider.fetchFileContents(owner, repo, sourceEntries, repoTree.commitId);
      const fileDataBatch = buildFileDataBatch(sourceEntries, contentMap);
      const featureFiles = extractFeatureFiles(fileDataBatch);

      // Store all file data
      await ctx.runMutation(internal.repoConnections.storeFileData, {
        repoConnectionId: args.repoConnectionId,
        commitSha: repoTree.commitId,
        totalFiles: fileDataBatch.length,
        languages,
        fileDataJson: JSON.stringify(fileDataBatch),
      });

      // Store detected feature files if any
      if (featureFiles.length > 0) {
        await ctx.runMutation(internal.repoConnections.storeDetectedFeatures, {
          repoConnectionId: args.repoConnectionId,
          detectedFeatureFiles: featureFiles,
        });
      }

      // Chain to ensureDockerfile pipeline
      await ctx.scheduler.runAfter(0, internal.pipelines.ensureDockerfile.ensureDockerfile, {
        repoConnectionId: args.repoConnectionId,
        bountyId: args.bountyId,
        fileDataJson: JSON.stringify(fileDataBatch),
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error during fetch";
      console.error(`fetchRepo failed: ${errorMessage}`);

      await ctx.runMutation(internal.repoConnections.updateStatus, {
        repoConnectionId: args.repoConnectionId,
        status: "failed",
        errorMessage,
      });
    }
  },
});
