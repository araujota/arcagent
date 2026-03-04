/**
 * Bitbucket API client implementing the RepoProvider interface.
 * Uses Bitbucket Cloud 2.0 API with Basic auth (app password).
 */
import type {
  RepoProvider,
  ParsedRepoUrl,
  RepoMetadata,
  RepoTree,
  NormalizedTreeEntry,
} from "./repoProviders";

export class BitbucketProvider implements RepoProvider {
  constructor(
    private readonly username: string,
    private readonly appPassword: string
  ) {}

  parseUrl(url: string): ParsedRepoUrl {
    const cleaned = url.trim().replace(/\.git$/, "").replace(/\/$/, "");

    // SSH: git@bitbucket.org:workspace/slug.git
    const sshMatch = cleaned.match(/^git@bitbucket\.org:([^/]+)\/(.+)$/);
    if (sshMatch) {
      return { provider: "bitbucket", owner: sshMatch[1], repo: sshMatch[2] };
    }

    // HTTPS: https://bitbucket.org/workspace/slug
    const httpsMatch = cleaned.match(
      /^https?:\/\/bitbucket\.org\/([^/]+)\/([^/]+)/
    );
    if (httpsMatch) {
      return {
        provider: "bitbucket",
        owner: httpsMatch[1],
        repo: httpsMatch[2],
      };
    }

    throw new Error(
      `Invalid Bitbucket URL: ${url}. Expected format: https://bitbucket.org/workspace/repo`
    );
  }

  private authHeader(): string {
    return "Basic " + btoa(`${this.username}:${this.appPassword}`);
  }

  private headers(): Record<string, string> {
    return {
      Authorization: this.authHeader(),
      "User-Agent": "arcagent",
    };
  }

  async fetchMetadata(owner: string, repo: string): Promise<RepoMetadata> {
    const res = await fetch(
      `https://api.bitbucket.org/2.0/repositories/${owner}/${repo}`,
      { headers: this.headers() }
    );

    if (!res.ok) {
      if (res.status === 404) {
        throw new Error(`Repository not found: ${owner}/${repo}`);
      }
      if (res.status === 401 || res.status === 403) {
        throw new Error(
          `Access denied to repository: ${owner}/${repo}. Check BITBUCKET_USERNAME and BITBUCKET_APP_PASSWORD.`
        );
      }
      throw new Error(`Bitbucket API error: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    return {
      defaultBranch: data.mainbranch?.name ?? "main",
      size: data.size ?? 0,
      visibility: data.is_private ? "private" : "public",
      language: data.language || null,
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
    let truncated = false;
    let totalPages = 0;

    // BFS traversal: Bitbucket /src/ only returns one directory level at a time
    const dirQueue: string[] = [""];

    while (dirQueue.length > 0) {
      const dirPath = dirQueue.shift()!;
      let url: string | null = this.buildTreePageUrl(owner, repo, commitId, dirPath);

      while (url) {
        const data = await this.fetchTreePage(url);
        this.appendTreeEntries(data.values ?? [], entries, dirQueue);
        url = typeof data.next === "string" ? data.next : null;
        totalPages++;
        if (totalPages > 500) {
          truncated = true;
          break;
        }
      }

      if (truncated) break;
    }

    return { commitId, entries, truncated };
  }

  private buildTreePageUrl(owner: string, repo: string, commitId: string, dirPath: string): string {
    const encodedDir = dirPath
      ? dirPath.split("/").map(encodeURIComponent).join("/") + "/"
      : "";
    return `https://api.bitbucket.org/2.0/repositories/${owner}/${repo}/src/${encodeURIComponent(commitId)}/${encodedDir}?pagelen=100`;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async fetchTreePage(url: string): Promise<Record<string, any>> {
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) {
      throw new Error(`Failed to fetch Bitbucket tree: ${res.status} ${res.statusText}`);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (await res.json()) as Record<string, any>;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private appendTreeEntries(values: any[], entries: NormalizedTreeEntry[], dirQueue: string[]): void {
    for (const item of values) {
      if (item.type === "commit_file") {
        entries.push({
          path: item.path,
          type: "blob",
          id: item.path,
          size: item.size,
        });
        continue;
      }
      if (item.type !== "commit_directory") continue;
      entries.push({
        path: item.path,
        type: "tree",
        id: item.path,
      });
      dirQueue.push(item.path);
    }
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
          // Encode each path segment individually to preserve literal slashes
          const encodedPath = entry.path.split("/").map(encodeURIComponent).join("/");
          const res = await fetch(
            `https://api.bitbucket.org/2.0/repositories/${owner}/${repo}/src/${encodeURIComponent(commitId)}/${encodedPath}`,
            { headers: this.headers() }
          );

          if (!res.ok) {
            console.warn(
              `[bitbucket] Failed to fetch ${entry.path}: ${res.status}`
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
      `https://api.bitbucket.org/2.0/repositories/${owner}/${repo}/refs/branches/${encodeURIComponent(branch)}`,
      { headers: this.headers() }
    );

    if (!res.ok) return null;
    const data = await res.json();
    return (data.target?.hash as string) ?? null;
  }
}
