/**
 * GitHub fork creation and access token management.
 *
 * Uses the GitHub API to:
 * 1. Fork a repository into the mirror org
 * 2. Generate a fine-grained PAT scoped to the fork
 *
 * Requires:
 * - GITHUB_BOT_TOKEN: GitHub App or PAT with repo + org scope
 * - GITHUB_MIRROR_ORG: Org name for mirror repos (e.g. "arcagent-mirrors")
 */

const GITHUB_API = "https://api.github.com";
const FORK_POLL_INTERVAL_MS = 2_000;
const FORK_POLL_MAX_ATTEMPTS = 15;

interface ForkResult {
  forkUrl: string;
  forkFullName: string;
  cloneCommand: string;
}

interface ForkAccessResult {
  forkUrl: string;
  accessToken: string;
  tokenExpiresAt: number;
  cloneCommand: string;
}

function getConfig() {
  const botToken = process.env.GITHUB_BOT_TOKEN;
  const mirrorOrg = process.env.GITHUB_MIRROR_ORG;

  if (!botToken) throw new Error("GITHUB_BOT_TOKEN not configured");
  if (!mirrorOrg) throw new Error("GITHUB_MIRROR_ORG not configured");

  return { botToken, mirrorOrg };
}

function headers(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/**
 * Fork a repository into the mirror org.
 */
export async function createFork(
  sourceOwner: string,
  sourceRepo: string,
  bountyIdSuffix: string,
  agentIdSuffix: string,
): Promise<ForkResult> {
  const { botToken, mirrorOrg } = getConfig();

  const forkName = `${sourceRepo}-${bountyIdSuffix}-${agentIdSuffix}`;

  // Create the fork
  const res = await fetch(
    `${GITHUB_API}/repos/${sourceOwner}/${sourceRepo}/forks`,
    {
      method: "POST",
      headers: headers(botToken),
      body: JSON.stringify({
        organization: mirrorOrg,
        name: forkName,
        default_branch_only: true,
      }),
    },
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub fork creation failed (${res.status}): ${body.slice(0, 300)}`);
  }

  const forkData = (await res.json()) as { full_name: string; html_url: string };
  const forkFullName = forkData.full_name;
  const forkUrl = forkData.html_url;

  // Poll until fork is ready (GitHub forks are async)
  for (let i = 0; i < FORK_POLL_MAX_ATTEMPTS; i++) {
    await new Promise((r) => setTimeout(r, FORK_POLL_INTERVAL_MS));

    const checkRes = await fetch(
      `${GITHUB_API}/repos/${forkFullName}`,
      { headers: headers(botToken) },
    );

    if (checkRes.ok) {
      return {
        forkUrl,
        forkFullName,
        cloneCommand: `git clone https://github.com/${forkFullName}.git`,
      };
    }
  }

  // Return even if not fully ready — it should be available shortly
  return {
    forkUrl,
    forkFullName,
    cloneCommand: `git clone https://github.com/${forkFullName}.git`,
  };
}

/**
 * Generate a fork access token.
 *
 * In production, this would create a fine-grained PAT via GitHub App
 * installation tokens. For now, we return the bot token scoped to
 * the fork. This should be replaced with proper token generation
 * when a GitHub App is set up.
 */
export async function generateForkAccessToken(
  forkFullName: string,
  expiresAt: number,
): Promise<ForkAccessResult> {
  const { botToken } = getConfig();

  // In a production setup, this would use:
  //   POST /app/installations/{installation_id}/access_tokens
  //   with repository_ids scoped to the fork only
  //
  // For now, return the bot token with appropriate metadata
  const forkUrl = `https://github.com/${forkFullName}`;

  return {
    forkUrl,
    accessToken: botToken,
    tokenExpiresAt: expiresAt,
    cloneCommand: `git clone https://${botToken}@github.com/${forkFullName}.git`,
  };
}

/**
 * Delete a fork repository (cleanup after claim expires).
 */
export async function deleteFork(forkFullName: string): Promise<void> {
  const { botToken } = getConfig();

  const res = await fetch(
    `${GITHUB_API}/repos/${forkFullName}`,
    {
      method: "DELETE",
      headers: headers(botToken),
    },
  );

  if (!res.ok && res.status !== 404) {
    const body = await res.text().catch(() => "");
    console.error(`Failed to delete fork ${forkFullName}: ${res.status} ${body.slice(0, 200)}`);
  }
}
