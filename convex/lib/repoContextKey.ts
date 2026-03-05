import type { RepoProviderName } from "./repoProviders";

export type NormalizedRepoContextKey = {
  provider: RepoProviderName;
  host: "github.com" | "gitlab.com" | "bitbucket.org";
  namespace: string;
  repo: string;
  repoPath: string;
  repoKey: string;
  repositoryUrlCanonical: string;
};

function normalizePathname(pathname: string): string[] {
  return pathname
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
}

function hostToProvider(host: string): RepoProviderName | null {
  if (host === "github.com") return "github";
  if (host === "gitlab.com") return "gitlab";
  if (host === "bitbucket.org") return "bitbucket";
  return null;
}

export function normalizeRepositoryForContext(input: string): NormalizedRepoContextKey {
  const raw = input.trim();
  if (!raw) {
    throw new Error("Repository URL is required");
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Invalid repository URL");
  }

  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== "https:" && protocol !== "http:") {
    throw new Error("Repository URL must start with http:// or https://");
  }

  const host = parsed.hostname.toLowerCase();
  const provider = hostToProvider(host);
  if (!provider) {
    throw new Error("Unsupported repository host. Supported: github.com, gitlab.com, bitbucket.org");
  }

  const segments = normalizePathname(parsed.pathname.toLowerCase());
  if (provider === "gitlab") {
    if (segments.length < 2) {
      throw new Error("Invalid GitLab repository URL");
    }
  } else if (segments.length !== 2) {
    throw new Error("Repository URL must include owner/workspace and repo name");
  }

  const repo = segments[segments.length - 1]!;
  const namespace = segments.slice(0, -1).join("/");
  const repoPath = `${namespace}/${repo}`;
  const repoKey = `${provider}:${repoPath}`;
  const repositoryUrlCanonical = `https://${host}/${repoPath}`;

  return {
    provider,
    host: host as "github.com" | "gitlab.com" | "bitbucket.org",
    namespace,
    repo,
    repoPath,
    repoKey,
    repositoryUrlCanonical,
  };
}

export function isSupportedRepositoryUrlForContext(input: string): boolean {
  try {
    normalizeRepositoryForContext(input);
    return true;
  } catch {
    return false;
  }
}
