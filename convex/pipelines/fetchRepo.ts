import { internalAction } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import {
  detectProvider,
  getRepoProvider,
  isSourceFile,
  MAX_FILE_SIZE,
  MAX_FILES,
} from "../lib/repoProviders";

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
      if (conn && (conn.status === "fetching" || conn.status === "parsing" || conn.status === "indexing")) {
        console.log(`[fetchRepo] Re-index already in progress for bounty ${args.bountyId}, skipping`);
        return;
      }

      // Update status to fetching
      await ctx.runMutation(internal.repoConnections.updateStatus, {
        repoConnectionId: args.repoConnectionId,
        status: "fetching",
      });

      // Detect provider and create client
      const providerName = conn?.provider ?? detectProvider(args.repositoryUrl);
      if (!providerName) {
        throw new Error(
          `Unsupported repository URL: ${args.repositoryUrl}. Supported: github.com, gitlab.com, bitbucket.org`
        );
      }
      const provider = getRepoProvider(providerName);

      // Parse the URL
      const { owner, repo } = provider.parseUrl(args.repositoryUrl);

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
      const sourceEntries = repoTree.entries.filter(
        (entry) =>
          entry.type === "blob" &&
          isSourceFile(entry.path) &&
          (!entry.size || entry.size <= MAX_FILE_SIZE)
      );

      if (sourceEntries.length > MAX_FILES) {
        throw new Error(
          `Repository has ${sourceEntries.length} source files, exceeding the limit of ${MAX_FILES}`
        );
      }

      // Detect languages from file paths
      const languageSet = new Set<string>();
      for (const entry of sourceEntries) {
        const ext = entry.path.split(".").pop()?.toLowerCase();
        if (ext) {
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
          const lang = langMap[ext];
          if (lang) languageSet.add(lang);
        }
      }

      // Fetch file contents via provider
      const contentMap = await provider.fetchFileContents(owner, repo, sourceEntries, repoTree.commitId);

      // Build file data batch
      const fileDataBatch: Array<{
        filePath: string;
        sha: string;
        content: string;
        size: number;
      }> = [];

      for (const entry of sourceEntries) {
        const content = contentMap.get(entry.id);
        if (content) {
          fileDataBatch.push({
            filePath: entry.path,
            sha: entry.id,
            content,
            size: content.length,
          });
        }
      }

      // Detect .feature files for Gherkin import
      const featureFiles = fileDataBatch
        .filter((f) => f.filePath.endsWith(".feature"))
        .map((f) => ({ filePath: f.filePath, content: f.content }));

      // Store all file data
      await ctx.runMutation(internal.repoConnections.storeFileData, {
        repoConnectionId: args.repoConnectionId,
        commitSha: repoTree.commitId,
        totalFiles: fileDataBatch.length,
        languages: Array.from(languageSet),
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
