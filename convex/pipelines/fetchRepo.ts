import { internalAction } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import {
  parseGitHubUrl,
  fetchRepoMetadata,
  fetchGitTree,
  fetchBlobBatch,
  isSourceFile,
  MAX_FILE_SIZE,
  MAX_FILES,
} from "../lib/github";

/**
 * Fetch a GitHub repository's structure and contents.
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
      // Update status to fetching
      await ctx.runMutation(internal.repoConnections.updateStatus, {
        repoConnectionId: args.repoConnectionId,
        status: "fetching",
      });

      const token = process.env.GITHUB_API_TOKEN;
      if (!token) {
        throw new Error("GITHUB_API_TOKEN environment variable is not set");
      }

      // Parse the GitHub URL
      const { owner, repo } = parseGitHubUrl(args.repositoryUrl);

      // Fetch repository metadata
      const metadata = await fetchRepoMetadata(owner, repo, token);

      // Update connection with repo info
      await ctx.runMutation(internal.repoConnections.updateMetadata, {
        repoConnectionId: args.repoConnectionId,
        owner,
        repo,
        defaultBranch: metadata.defaultBranch,
      });

      // Fetch the full recursive git tree
      const gitTree = await fetchGitTree(
        owner,
        repo,
        metadata.defaultBranch,
        token
      );

      if (gitTree.truncated) {
        console.warn(
          `Git tree was truncated for ${owner}/${repo}. Some files may be missing.`
        );
      }

      // Filter to source files only
      const sourceFiles = gitTree.tree.filter(
        (entry) =>
          entry.type === "blob" &&
          isSourceFile(entry.path) &&
          (!entry.size || entry.size <= MAX_FILE_SIZE)
      );

      if (sourceFiles.length > MAX_FILES) {
        throw new Error(
          `Repository has ${sourceFiles.length} source files, exceeding the limit of ${MAX_FILES}`
        );
      }

      // Detect languages from file paths
      const languageSet = new Set<string>();
      for (const file of sourceFiles) {
        const ext = file.path.split(".").pop()?.toLowerCase();
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

      // Fetch file contents in batches
      const shas = sourceFiles.map((f) => f.sha);
      const blobContents = await fetchBlobBatch(owner, repo, shas, token);

      // Store file data by scheduling mutations
      // We'll store as a batch operation
      const fileDataBatch: Array<{
        filePath: string;
        sha: string;
        content: string;
        size: number;
      }> = [];

      for (const file of sourceFiles) {
        const content = blobContents.get(file.sha);
        if (content) {
          fileDataBatch.push({
            filePath: file.path,
            sha: file.sha,
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
        commitSha: gitTree.sha,
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
