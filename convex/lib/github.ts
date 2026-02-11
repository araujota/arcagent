/**
 * GitHub API utilities for repo fetching.
 * Used by the fetchRepo pipeline to retrieve repository structure and contents.
 */

// Directories to exclude from indexing
export const EXCLUDED_DIRS = [
  "node_modules/",
  "vendor/",
  ".git/",
  "dist/",
  "build/",
  "__pycache__/",
  ".next/",
  ".nuxt/",
  ".cache/",
  ".tox/",
  "target/",
  "coverage/",
  ".nyc_output/",
  ".pytest_cache/",
  "venv/",
  ".venv/",
  "env/",
  ".env/",
  "bower_components/",
  ".idea/",
  ".vscode/",
];

// Binary file extensions to skip
export const BINARY_EXTENSIONS = [
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".svg", ".bmp", ".webp",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".mp3", ".mp4", ".avi", ".mov", ".wmv", ".flv", ".wav",
  ".exe", ".dll", ".so", ".dylib", ".o", ".a",
  ".pyc", ".pyo", ".class", ".jar", ".war",
  ".lock", ".map",
  ".min.js", ".min.css",
  ".DS_Store",
];

// Max individual file size to fetch (1MB)
export const MAX_FILE_SIZE = 1_000_000;

// Max files to process per repo
export const MAX_FILES = 50_000;

export interface ParsedGitHubUrl {
  owner: string;
  repo: string;
}

export interface RepoMetadata {
  defaultBranch: string;
  size: number;
  visibility: string;
  language: string | null;
}

export interface GitTreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree";
  sha: string;
  size?: number;
}

export interface GitTree {
  sha: string;
  tree: GitTreeEntry[];
  truncated: boolean;
}

export interface BlobContent {
  sha: string;
  content: string;
  encoding: string;
  size: number;
}

/**
 * Parse a GitHub URL into owner and repo.
 * Supports: https://github.com/owner/repo, https://github.com/owner/repo.git,
 * git@github.com:owner/repo.git
 */
export function parseGitHubUrl(url: string): ParsedGitHubUrl {
  // Clean up the URL
  let cleaned = url.trim().replace(/\.git$/, "").replace(/\/$/, "");

  // Handle SSH format: git@github.com:owner/repo
  const sshMatch = cleaned.match(/^git@github\.com:([^/]+)\/(.+)$/);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  // Handle HTTPS format: https://github.com/owner/repo
  const httpsMatch = cleaned.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)/
  );
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }

  throw new Error(
    `Invalid GitHub URL: ${url}. Expected format: https://github.com/owner/repo`
  );
}

/**
 * Fetch repository metadata (default branch, size, etc.)
 */
export async function fetchRepoMetadata(
  owner: string,
  repo: string,
  token: string
): Promise<RepoMetadata> {
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "arcagent",
      },
    }
  );

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`Repository not found: ${owner}/${repo}`);
    }
    if (response.status === 403) {
      const remaining = response.headers.get("X-RateLimit-Remaining");
      if (remaining === "0") {
        throw new Error("GitHub API rate limit exceeded");
      }
      throw new Error(`Access denied to repository: ${owner}/${repo}`);
    }
    throw new Error(
      `GitHub API error: ${response.status} ${response.statusText}`
    );
  }

  const data = await response.json();
  return {
    defaultBranch: data.default_branch,
    size: data.size,
    visibility: data.visibility || (data.private ? "private" : "public"),
    language: data.language,
  };
}

/**
 * Fetch the full recursive git tree in one API call.
 */
export async function fetchGitTree(
  owner: string,
  repo: string,
  branch: string,
  token: string
): Promise<GitTree> {
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "arcagent",
      },
    }
  );

  if (!response.ok) {
    throw new Error(
      `Failed to fetch git tree: ${response.status} ${response.statusText}`
    );
  }

  return await response.json();
}

/**
 * Fetch file contents via the blob API in batches.
 * Returns a map of sha → decoded content.
 */
export async function fetchBlobBatch(
  owner: string,
  repo: string,
  shas: string[],
  token: string
): Promise<Map<string, string>> {
  const results = new Map<string, string>();

  // Process in batches of 50 to respect rate limits
  const batchSize = 50;
  for (let i = 0; i < shas.length; i += batchSize) {
    const batch = shas.slice(i, i + batchSize);
    const promises = batch.map(async (sha) => {
      const response = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/git/blobs/${sha}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github.v3+json",
            "User-Agent": "arcagent",
          },
        }
      );

      if (!response.ok) {
        console.warn(`Failed to fetch blob ${sha}: ${response.status}`);
        return null;
      }

      const data: BlobContent = await response.json();
      if (data.encoding === "base64") {
        try {
          const decoded = atob(data.content.replace(/\n/g, ""));
          return { sha, content: decoded };
        } catch {
          console.warn(`Failed to decode blob ${sha}`);
          return null;
        }
      }
      return { sha, content: data.content };
    });

    const batchResults = await Promise.all(promises);
    for (const result of batchResults) {
      if (result) {
        results.set(result.sha, result.content);
      }
    }
  }

  return results;
}

/**
 * Check rate limit status from response headers.
 * Returns remaining requests and reset time.
 */
export function checkRateLimit(headers: Headers): {
  remaining: number;
  resetAt: number;
} {
  const remaining = parseInt(
    headers.get("X-RateLimit-Remaining") || "5000",
    10
  );
  const resetAt =
    parseInt(headers.get("X-RateLimit-Reset") || "0", 10) * 1000;
  return { remaining, resetAt };
}

/**
 * Determine if a file path should be indexed as source code.
 */
export function isSourceFile(path: string): boolean {
  // Check excluded directories
  for (const dir of EXCLUDED_DIRS) {
    if (path.startsWith(dir) || path.includes(`/${dir}`)) {
      return false;
    }
  }

  // Check binary extensions
  const lowerPath = path.toLowerCase();
  for (const ext of BINARY_EXTENSIONS) {
    if (lowerPath.endsWith(ext)) {
      return false;
    }
  }

  // Must have an extension (skip files like LICENSE, Makefile are ok)
  const sourceExtensions = [
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
    ".py", ".pyi",
    ".go",
    ".rs",
    ".java", ".kt", ".scala",
    ".c", ".h", ".cpp", ".hpp", ".cc", ".hh",
    ".cs",
    ".rb",
    ".php",
    ".swift",
    ".dart",
    ".lua",
    ".sh", ".bash", ".zsh",
    ".sql",
    ".graphql", ".gql",
    ".proto",
    ".yaml", ".yml",
    ".json",
    ".toml",
    ".xml",
    ".html", ".css", ".scss", ".less",
    ".md", ".mdx",
    ".vue", ".svelte",
    "Dockerfile", "Makefile", "CMakeLists.txt",
  ];

  // Check known source extensions
  for (const ext of sourceExtensions) {
    if (lowerPath.endsWith(ext)) {
      return true;
    }
  }

  // Check for special filenames without extensions
  const basename = path.split("/").pop() || "";
  const specialFiles = [
    "Dockerfile",
    "Makefile",
    "Rakefile",
    "Gemfile",
    "Procfile",
    ".gitignore",
    ".eslintrc",
    ".prettierrc",
  ];
  if (specialFiles.includes(basename)) {
    return true;
  }

  return false;
}
