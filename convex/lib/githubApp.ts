import { parseGitHubUrl } from "./github";
import { fetchWithRetry } from "./httpRetry";

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

function encodeDerLength(length: number): Uint8Array {
  if (length < 0x80) return new Uint8Array([length]);

  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>= 8;
  }

  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function encodeDerTlv(tag: number, value: Uint8Array): Uint8Array {
  const length = encodeDerLength(value.length);
  const out = new Uint8Array(1 + length.length + value.length);
  out[0] = tag;
  out.set(length, 1);
  out.set(value, 1 + length.length);
  return out;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function pkcs1ToPkcs8(pkcs1Bytes: Uint8Array): Uint8Array {
  // PKCS#8 wrapper:
  // SEQUENCE {
  //   INTEGER 0
  //   SEQUENCE { OID rsaEncryption, NULL }
  //   OCTET STRING <PKCS#1 RSAPrivateKey DER>
  // }
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const algorithmIdentifier = new Uint8Array([
    0x30, 0x0d,
    0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
    0x05, 0x00,
  ]);
  const privateKeyOctetString = encodeDerTlv(0x04, pkcs1Bytes);

  return encodeDerTlv(0x30, concatBytes([version, algorithmIdentifier, privateKeyOctetString]));
}

function pemToPkcs8Bytes(pem: string): Uint8Array {
  const trimmed = pem.trim();
  let body = "";
  let isPkcs1Rsa = false;

  if (trimmed.includes("-----BEGIN PRIVATE KEY-----")) {
    body = trimmed
      .replace("-----BEGIN PRIVATE KEY-----", "")
      .replace("-----END PRIVATE KEY-----", "")
      .replace(/\s+/g, "");
  } else if (trimmed.includes("-----BEGIN RSA PRIVATE KEY-----")) {
    isPkcs1Rsa = true;
    body = trimmed
      .replace("-----BEGIN RSA PRIVATE KEY-----", "")
      .replace("-----END RSA PRIVATE KEY-----", "")
      .replace(/\s+/g, "");
  } else {
    throw new Error("Unsupported private key format. Expected PKCS#8 or PKCS#1 PEM.");
  }

  const decoded = atob(body);
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i += 1) {
    bytes[i] = decoded.charCodeAt(i);
  }

  return isPkcs1Rsa ? pkcs1ToPkcs8(bytes) : bytes;
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

export function requiresGitHubInstallationToken(repositoryUrl: string): boolean {
  return parseGitHubRepoUrlSafe(repositoryUrl) !== null;
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

export async function findGitHubInstallationForRepo(
  owner: string,
  repo: string,
): Promise<GitHubInstallationInfo | null> {
  if (!isGitHubAppConfigured()) return null;

  const response = await fetchWithRetry(
    `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${await createGitHubAppJwt()}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "arcagent-convex",
      },
    },
    { attempts: 3 },
  );

  // Keep the path for clearer non-retry errors.
  const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`;

  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Failed to resolve GitHub App installation for ${owner}/${repo} (${path}): ${response.status} ${body.slice(0, 300)}`,
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
  const response = await fetchWithRetry(
    `${GITHUB_API_BASE}/app/installations/${args.installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/vnd.github+json",
        "Authorization": `Bearer ${await createGitHubAppJwt()}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "arcagent-convex",
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
    },
    { attempts: 3 },
  );

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

  const token = await mintGitHubInstallationToken({
    installationId,
    repo: parsed.repo,
    writeAccess: args.writeAccess,
  });

  return {
    installationId,
    accountLogin: discovered.accountLogin,
    token,
  };
}
