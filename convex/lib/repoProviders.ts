/**
 * Multi-provider repo connection abstraction.
 * Provides a uniform interface for GitHub, GitLab, and Bitbucket.
 *
 * Usage:
 *   const providerName = detectProvider(url);
 *   const provider = getRepoProvider(providerName);
 *   const metadata = await provider.fetchMetadata(owner, repo);
 */

import { v } from "convex/values";
import { GitHubProvider, isSourceFile, MAX_FILE_SIZE, MAX_FILES } from "./github";
import { GitLabProvider } from "./gitlab";
import { BitbucketProvider } from "./bitbucket";

// Re-export provider-agnostic file filtering utilities
export { isSourceFile, MAX_FILE_SIZE, MAX_FILES };

export type RepoProviderName = "github" | "gitlab" | "bitbucket";

/** Convex validator for RepoProviderName — use in schema and args. */
export const repoProviderValidator = v.union(
  v.literal("github"),
  v.literal("gitlab"),
  v.literal("bitbucket")
);

export interface ParsedRepoUrl {
  provider: RepoProviderName;
  owner: string;
  repo: string;
}

export interface RepoMetadata {
  defaultBranch: string;
  size: number;
  visibility: string;
  language: string | null;
}

export interface NormalizedTreeEntry {
  path: string;
  type: "blob" | "tree";
  id: string; // SHA for GitHub/GitLab, path for Bitbucket
  size?: number;
}

export interface RepoTree {
  commitId: string;
  entries: NormalizedTreeEntry[];
  truncated: boolean;
}

export interface RepoProvider {
  parseUrl(url: string): ParsedRepoUrl;
  fetchMetadata(owner: string, repo: string): Promise<RepoMetadata>;
  fetchTree(owner: string, repo: string, branch: string): Promise<RepoTree>;
  fetchFileContents(
    owner: string,
    repo: string,
    entries: NormalizedTreeEntry[],
    commitId: string
  ): Promise<Map<string, string>>;
  fetchHeadCommitId(
    owner: string,
    repo: string,
    branch: string
  ): Promise<string | null>;
}

/**
 * Detect the provider from a repository URL.
 * Returns null if the URL doesn't match any supported provider.
 */
export function detectProvider(url: string): RepoProviderName | null {
  const trimmed = url.trim();
  if (/^https?:\/\/github\.com\//.test(trimmed) || /^git@github\.com:/.test(trimmed)) {
    return "github";
  }
  if (/^https?:\/\/gitlab\.com\//.test(trimmed) || /^git@gitlab\.com:/.test(trimmed)) {
    return "gitlab";
  }
  if (/^https?:\/\/bitbucket\.org\//.test(trimmed) || /^git@bitbucket\.org:/.test(trimmed)) {
    return "bitbucket";
  }
  return null;
}

/**
 * Parse a repository URL into provider, owner, and repo.
 * Throws if the URL doesn't match any supported provider.
 */
export function parseRepoUrl(url: string): ParsedRepoUrl {
  const provider = detectProvider(url);
  if (!provider) {
    throw new Error(
      `Unsupported repository URL: ${url}. Supported: github.com, gitlab.com, bitbucket.org`
    );
  }

  const p = getRepoProvider(provider);
  return p.parseUrl(url);
}

/**
 * Returns a configured RepoProvider for the given provider name.
 * Reads credentials from process.env — call only inside Convex actions.
 */
export function getRepoProvider(
  provider: RepoProviderName,
  options?: { githubToken?: string }
): RepoProvider {
  switch (provider) {
    case "github": {
      const token = options?.githubToken ?? process.env.GITHUB_API_TOKEN;
      if (!token) throw new Error("GITHUB_API_TOKEN environment variable is not set");
      return new GitHubProvider(token);
    }
    case "gitlab": {
      const token = process.env.GITLAB_API_TOKEN;
      if (!token) throw new Error("GITLAB_API_TOKEN environment variable is not set");
      return new GitLabProvider(token);
    }
    case "bitbucket": {
      const username = process.env.BITBUCKET_USERNAME;
      const password = process.env.BITBUCKET_APP_PASSWORD;
      if (!username || !password) {
        throw new Error(
          "BITBUCKET_USERNAME and BITBUCKET_APP_PASSWORD environment variables must be set"
        );
      }
      return new BitbucketProvider(username, password);
    }
    default: {
      const _exhaustive: never = provider;
      throw new Error(`Unknown provider: ${_exhaustive}`);
    }
  }
}
