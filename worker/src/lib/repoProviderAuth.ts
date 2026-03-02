export type RepoProvider = "github" | "gitlab" | "bitbucket";

export type ParsedRepoRef =
  | {
      provider: "github";
      owner: string;
      repo: string;
    }
  | {
      provider: "gitlab";
      namespace: string;
      repo: string;
    }
  | {
      provider: "bitbucket";
      workspace: string;
      repo: string;
    };

const REPO_TOKEN_PATTERN = /^[A-Za-z0-9._~%+\-=/]+$/;

function trimGitSuffix(value: string): string {
  return value.trim().replace(/\.git$/i, "").replace(/\/$/, "");
}

export function detectRepoProvider(repoUrl: string): RepoProvider | null {
  const trimmed = repoUrl.trim();
  if (/^https?:\/\/github\.com\//i.test(trimmed) || /^git@github\.com:/i.test(trimmed)) {
    return "github";
  }
  if (/^https?:\/\/gitlab\.com\//i.test(trimmed) || /^git@gitlab\.com:/i.test(trimmed)) {
    return "gitlab";
  }
  if (/^https?:\/\/bitbucket\.org\//i.test(trimmed) || /^git@bitbucket\.org:/i.test(trimmed)) {
    return "bitbucket";
  }
  return null;
}

export function parseRepoRef(repoUrl: string): ParsedRepoRef | null {
  const cleaned = trimGitSuffix(repoUrl);

  const githubMatch = cleaned.match(/^(?:https?:\/\/github\.com\/|git@github\.com:)([^/]+)\/([^/]+)$/i);
  if (githubMatch) {
    return {
      provider: "github",
      owner: githubMatch[1],
      repo: githubMatch[2],
    };
  }

  const gitlabMatch = cleaned.match(/^(?:https?:\/\/gitlab\.com\/|git@gitlab\.com:)(.+)$/i);
  if (gitlabMatch) {
    const parts = gitlabMatch[1].split("/").filter(Boolean);
    if (parts.length >= 2) {
      const repo = parts[parts.length - 1];
      const namespace = parts.slice(0, -1).join("/");
      return {
        provider: "gitlab",
        namespace,
        repo,
      };
    }
  }

  const bitbucketMatch = cleaned.match(
    /^(?:https?:\/\/bitbucket\.org\/|git@bitbucket\.org:)([^/]+)\/([^/]+)$/i,
  );
  if (bitbucketMatch) {
    return {
      provider: "bitbucket",
      workspace: bitbucketMatch[1],
      repo: bitbucketMatch[2],
    };
  }

  return null;
}

function baseCloneUrl(parsed: ParsedRepoRef): string {
  switch (parsed.provider) {
    case "github":
      return `https://github.com/${parsed.owner}/${parsed.repo}.git`;
    case "gitlab":
      return `https://gitlab.com/${parsed.namespace}/${parsed.repo}.git`;
    case "bitbucket":
      return `https://bitbucket.org/${parsed.workspace}/${parsed.repo}.git`;
  }
}

function providerLabel(provider: RepoProvider): string {
  switch (provider) {
    case "github":
      return "GitHub";
    case "gitlab":
      return "GitLab";
    case "bitbucket":
      return "Bitbucket";
  }
}

function defaultAuthUsername(provider: RepoProvider): string {
  switch (provider) {
    case "github":
      return "x-access-token";
    case "gitlab":
      return "oauth2";
    case "bitbucket":
      return "x-token-auth";
  }
}

export function buildAuthenticatedCloneRepoUrl(
  repoUrl: string,
  repoAuthToken?: string,
  repoAuthUsername?: string,
): { url: string; provider: RepoProvider | null; tokenForRedaction?: string } {
  const parsed = parseRepoRef(repoUrl);
  if (!parsed) {
    return {
      url: repoUrl,
      provider: detectRepoProvider(repoUrl),
      tokenForRedaction: repoAuthToken,
    };
  }

  const provider = parsed.provider;
  const normalizedUrl = baseCloneUrl(parsed);

  if (provider === "github" && !repoAuthToken) {
    throw new Error("Missing repoAuthToken for GitHub repository clone");
  }

  if (!repoAuthToken) {
    return { url: normalizedUrl, provider };
  }

  if (!REPO_TOKEN_PATTERN.test(repoAuthToken)) {
    throw new Error("Invalid repoAuthToken format");
  }

  const username = repoAuthUsername?.trim() || defaultAuthUsername(provider);
  if (!/^[A-Za-z0-9._~%+\-]+$/.test(username)) {
    throw new Error("Invalid repoAuthUsername format");
  }

  const encodedUser = encodeURIComponent(username);
  const encodedToken = encodeURIComponent(repoAuthToken);

  return {
    url: normalizedUrl.replace("https://", `https://${encodedUser}:${encodedToken}@`),
    provider,
    tokenForRedaction: repoAuthToken,
  };
}

export function repoRefToPath(parsed: ParsedRepoRef): string {
  switch (parsed.provider) {
    case "github":
      return `${parsed.owner}/${parsed.repo}`;
    case "gitlab":
      return `${parsed.namespace}/${parsed.repo}`;
    case "bitbucket":
      return `${parsed.workspace}/${parsed.repo}`;
  }
}

export function ensureParsedRepoRef(repoUrl: string): ParsedRepoRef {
  const parsed = parseRepoRef(repoUrl);
  if (!parsed) {
    throw new Error(
      "Unsupported repository URL. Supported hosts: github.com, gitlab.com, bitbucket.org",
    );
  }
  return parsed;
}

export function providerDisplayName(repoUrl: string): string {
  const provider = detectRepoProvider(repoUrl);
  return provider ? providerLabel(provider) : "Repository";
}
