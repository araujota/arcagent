import { parseGitHubUrl } from "./github";

const GITHUB_API_BASE = "https://api.github.com";

export interface GitHubRepoRef {
  owner: string;
  repo: string;
}

export interface GitHubInstallationInfo {
  installationId: number;
  accountLogin?: string;
}

export interface GitHubRepoAccessTokenResult extends GitHubInstallationInfo {
  token: string;
}

function getTrimmedEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : null;
}

function normalizePrivateKey(rawKey: string): string {
  return rawKey.includes("\\n") ? rawKey.replace(/\\n/g, "\n") : rawKey;
}

function base64UrlEncodeBytes(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlEncodeText(value: string): string {
  return base64UrlEncodeBytes(new TextEncoder().encode(value));
}

function pemToPkcs8Bytes(pem: string): Uint8Array {
  const body = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s+/g, "");

  const decoded = atob(body);
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i += 1) {
    bytes[i] = decoded.charCodeAt(i);
  }
  return bytes;
}

function getGitHubAppConfig(): { appId: string; privateKey: string } {
  const appId = getTrimmedEnv("GITHUB_APP_ID");
  const privateKey = getTrimmedEnv("GITHUB_APP_PRIVATE_KEY");
  if (!appId || !privateKey) {
    throw new Error("GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY must be configured");
  }
  return {
    appId,
    privateKey: normalizePrivateKey(privateKey),
  };
}

export function isGitHubAppConfigured(): boolean {
  return Boolean(getTrimmedEnv("GITHUB_APP_ID") && getTrimmedEnv("GITHUB_APP_PRIVATE_KEY"));
}

export function getGitHubAppInstallUrl(): string | null {
  const slug = getTrimmedEnv("GITHUB_APP_SLUG");
  if (!slug) return null;
  return `https://github.com/apps/${slug}/installations/new`;
}

export function parseGitHubRepoUrlSafe(repositoryUrl: string): GitHubRepoRef | null {
  try {
    const { owner, repo } = parseGitHubUrl(repositoryUrl);
    return { owner, repo };
  } catch {
    return null;
  }
}

async function createGitHubAppJwt(): Promise<string> {
  const { appId, privateKey } = getGitHubAppConfig();

  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: nowSeconds - 60,
    exp: nowSeconds + 540,
    iss: appId,
  };

  const signingInput = `${base64UrlEncodeText(JSON.stringify(header))}.${base64UrlEncodeText(
    JSON.stringify(payload),
  )}`;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8Bytes(privateKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput)),
  );

  return `${signingInput}.${base64UrlEncodeBytes(signature)}`;
}

async function githubAppFetch(path: string, init?: RequestInit): Promise<Response> {
  const appJwt = await createGitHubAppJwt();
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/vnd.github+json");
  headers.set("Authorization", `Bearer ${appJwt}`);
  headers.set("X-GitHub-Api-Version", "2022-11-28");
  headers.set("User-Agent", "arcagent-convex");

  return fetch(`${GITHUB_API_BASE}${path}`, {
    ...init,
    headers,
  });
}

export async function findGitHubInstallationForRepo(
  owner: string,
  repo: string,
): Promise<GitHubInstallationInfo | null> {
  if (!isGitHubAppConfigured()) return null;

  const response = await githubAppFetch(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`,
  );

  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Failed to resolve GitHub App installation for ${owner}/${repo}: ${response.status} ${body.slice(0, 300)}`,
    );
  }

  const payload = (await response.json()) as { id?: number; account?: { login?: string } };
  if (!payload.id) {
    throw new Error(`GitHub installation response missing id for ${owner}/${repo}`);
  }

  return {
    installationId: payload.id,
    accountLogin: payload.account?.login,
  };
}

export async function mintGitHubInstallationToken(args: {
  installationId: number;
  repo: string;
  writeAccess?: boolean;
}): Promise<string> {
  const response = await githubAppFetch(`/app/installations/${args.installationId}/access_tokens`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      repositories: [args.repo],
      permissions: args.writeAccess
        ? {
            contents: "write",
            pull_requests: "write",
          }
        : {
            contents: "read",
          },
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Failed to mint GitHub installation token (${response.status}): ${body.slice(0, 300)}`,
    );
  }

  const payload = (await response.json()) as { token?: string };
  if (!payload.token) {
    throw new Error("GitHub token mint response missing token");
  }

  return payload.token;
}

/**
 * Resolve a short-lived GitHub installation token for a repository.
 *
 * Returns null when the app is not configured or not installed on the target repo.
 */
export async function resolveGitHubTokenForRepo(args: {
  repositoryUrl: string;
  preferredInstallationId?: number;
  writeAccess?: boolean;
}): Promise<GitHubRepoAccessTokenResult | null> {
  if (!isGitHubAppConfigured()) return null;

  const parsed = parseGitHubRepoUrlSafe(args.repositoryUrl);
  if (!parsed) return null;

  let installationId = args.preferredInstallationId;
  let accountLogin: string | undefined;

  if (installationId) {
    try {
      const token = await mintGitHubInstallationToken({
        installationId,
        repo: parsed.repo,
        writeAccess: args.writeAccess,
      });
      return { installationId, token };
    } catch {
      installationId = undefined;
    }
  }

  const discovered = await findGitHubInstallationForRepo(parsed.owner, parsed.repo);
  if (!discovered) return null;

  installationId = discovered.installationId;
  accountLogin = discovered.accountLogin;

  const token = await mintGitHubInstallationToken({
    installationId,
    repo: parsed.repo,
    writeAccess: args.writeAccess,
  });

  return {
    installationId,
    accountLogin,
    token,
  };
}
