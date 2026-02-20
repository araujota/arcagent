/**
 * GitLab API client implementing the RepoProvider interface.
 * Uses GitLab API v4 with PRIVATE-TOKEN authentication.
 */
import type {
  RepoProvider,
  ParsedRepoUrl,
  RepoMetadata,
  RepoTree,
  NormalizedTreeEntry,
} from "./repoProviders";

export class GitLabProvider implements RepoProvider {
  private readonly baseUrl = "https://gitlab.com";

  constructor(private token: string) {}

  parseUrl(url: string): ParsedRepoUrl {
    const cleaned = url.trim().replace(/\.git$/, "").replace(/\/$/, "");

    // SSH: git@gitlab.com:owner/repo.git
    const sshMatch = cleaned.match(/^git@gitlab\.com:(.+)$/);
    if (sshMatch) {
      const parts = sshMatch[1].split("/");
      const repo = parts.pop()!;
      const owner = parts.join("/");
      if (!owner) throw new Error(`Invalid GitLab URL: ${url}. Owner/namespace is required.`);
      return { provider: "gitlab", owner, repo };
    }

    // HTTPS: https://gitlab.com/owner/repo or https://gitlab.com/group/subgroup/repo
    const httpsMatch = cleaned.match(/^https?:\/\/gitlab\.com\/(.+)$/);
    if (httpsMatch) {
      const parts = httpsMatch[1].split("/");
      const repo = parts.pop()!;
      const owner = parts.join("/");
      if (!owner) throw new Error(`Invalid GitLab URL: ${url}. Owner/namespace is required.`);
      return { provider: "gitlab", owner, repo };
    }

    throw new Error(
      `Invalid GitLab URL: ${url}. Expected format: https://gitlab.com/owner/repo`
    );
  }

  private projectId(owner: string, repo: string): string {
    return encodeURIComponent(`${owner}/${repo}`);
  }

  private headers(): Record<string, string> {
    return { "PRIVATE-TOKEN": this.token, "User-Agent": "arcagent" };
  }

  async fetchMetadata(owner: string, repo: string): Promise<RepoMetadata> {
    const res = await fetch(
      `${this.baseUrl}/api/v4/projects/${this.projectId(owner, repo)}`,
      { headers: this.headers() }
    );

    if (!res.ok) {
      if (res.status === 404) {
        throw new Error(`Repository not found: ${owner}/${repo}`);
      }
      if (res.status === 401 || res.status === 403) {
        throw new Error(
          `Access denied to repository: ${owner}/${repo}. Check GITLAB_API_TOKEN.`
        );
      }
      throw new Error(`GitLab API error: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    return {
      defaultBranch: data.default_branch ?? "main",
      size: data.statistics?.repository_size ?? 0,
      visibility: data.visibility ?? "private",
      language: null, // GitLab languages endpoint is separate; skip for parity
    };
  }

  async fetchTree(
    owner: string,
    repo: string,
    branch: string
  ): Promise<RepoTree> {
    const commitId =
      (await this.fetchHeadCommitId(owner, repo, branch)) ?? branch;

    const entries: NormalizedTreeEntry[] = [];
    let page = 1;
    let truncated = false;
    const PER_PAGE = 100;

    while (true) {
      const res = await fetch(
        `${this.baseUrl}/api/v4/projects/${this.projectId(owner, repo)}/repository/tree` +
          `?recursive=true&ref=${encodeURIComponent(branch)}&per_page=${PER_PAGE}&page=${page}`,
        { headers: this.headers() }
      );

      if (!res.ok) {
        throw new Error(
          `Failed to fetch GitLab tree: ${res.status} ${res.statusText}`
        );
      }

      const items: Array<{ path: string; type: string; id: string }> =
        await res.json();

      for (const item of items) {
        entries.push({
          path: item.path,
          type: item.type === "blob" ? "blob" : "tree",
          id: item.id,
        });
      }

      const nextPage = res.headers.get("x-next-page");
      if (!nextPage) break;
      page++;
      if (page > 500) {
        truncated = true;
        break;
      }
    }

    return { commitId, entries, truncated };
  }

  async fetchFileContents(
    owner: string,
    repo: string,
    entries: NormalizedTreeEntry[],
    commitId: string
  ): Promise<Map<string, string>> {
    const results = new Map<string, string>();
    const BATCH = 20;

    for (let i = 0; i < entries.length; i += BATCH) {
      const batch = entries.slice(i, i + BATCH);
      await Promise.all(
        batch.map(async (entry) => {
          const res = await fetch(
            `${this.baseUrl}/api/v4/projects/${this.projectId(owner, repo)}/repository/files/` +
              `${encodeURIComponent(entry.path)}/raw?ref=${encodeURIComponent(commitId)}`,
            { headers: this.headers() }
          );

          if (!res.ok) {
            console.warn(
              `[gitlab] Failed to fetch ${entry.path}: ${res.status}`
            );
            return;
          }

          results.set(entry.id, await res.text());
        })
      );
    }

    return results;
  }

  async fetchHeadCommitId(
    owner: string,
    repo: string,
    branch: string
  ): Promise<string | null> {
    const res = await fetch(
      `${this.baseUrl}/api/v4/projects/${this.projectId(owner, repo)}/repository/commits/${encodeURIComponent(branch)}`,
      { headers: this.headers() }
    );

    if (!res.ok) return null;
    const data = await res.json();
    return (data.id as string) ?? null;
  }
}
