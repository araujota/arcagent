import { detectProvider, type RepoProviderName } from "./repoProviders";
import {
  requiresGitHubInstallationToken,
  resolveGitHubTokenForRepo,
} from "./githubApp";

export interface RepoAuthResolution {
  provider: RepoProviderName | null;
  repoAuthToken?: string;
  repoAuthUsername?: string;
  source: "github_app" | "provider_connection" | "env_fallback" | "none";
  installationId?: number;
  accountLogin?: string;
}

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

export function requiresCloneAuthToken(repositoryUrl: string): boolean {
  return requiresGitHubInstallationToken(repositoryUrl);
}

export function requiresWriteAuthToken(repositoryUrl: string): boolean {
  const provider = detectProvider(repositoryUrl);
  return provider === "github" || provider === "gitlab" || provider === "bitbucket";
}

export async function resolveRepoAuth(args: {
  repositoryUrl: string;
  preferredGitHubInstallationId?: number;
  writeAccess?: boolean;
  providerToken?: string;
  providerUsername?: string;
}): Promise<RepoAuthResolution> {
  const provider = detectProvider(args.repositoryUrl);
  if (!provider) {
    return {
      provider: null,
      source: "none",
    };
  }

  if (provider === "github") {
    const tokenResult = await resolveGitHubTokenForRepo({
      repositoryUrl: args.repositoryUrl,
      preferredInstallationId: args.preferredGitHubInstallationId,
      writeAccess: args.writeAccess,
    });

    return {
      provider,
      repoAuthToken: tokenResult?.token,
      source: tokenResult?.token ? "github_app" : "none",
      installationId: tokenResult?.installationId,
      accountLogin: tokenResult?.accountLogin,
    };
  }

  if (args.providerToken) {
    return {
      provider,
      repoAuthToken: args.providerToken,
      repoAuthUsername: args.providerUsername,
      source: "provider_connection",
    };
  }

  if (provider === "gitlab") {
    const token = env("GITLAB_FALLBACK_API_TOKEN") ?? env("GITLAB_API_TOKEN");
    return {
      provider,
      repoAuthToken: token,
      source: token ? "env_fallback" : "none",
    };
  }

  const username = env("BITBUCKET_FALLBACK_USERNAME") ?? env("BITBUCKET_USERNAME");
  const appPassword =
    env("BITBUCKET_FALLBACK_APP_PASSWORD") ?? env("BITBUCKET_APP_PASSWORD");
  if (!username || !appPassword) {
    return {
      provider,
      source: "none",
    };
  }

  return {
    provider,
    repoAuthToken: appPassword,
    repoAuthUsername: username,
    source: "env_fallback",
  };
}
