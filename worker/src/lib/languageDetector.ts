import { logger } from "../index";

/**
 * Language detection based on repository heuristics.
 *
 * When a language hint is not provided with the verification request, this
 * module examines the repository URL (and eventually the file listing from
 * the VM) to determine the primary language.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SupportedLanguage =
  | "typescript"
  | "javascript"
  | "python"
  | "rust"
  | "go"
  | "java"
  | "unknown";

/** Indicator file and its associated language. */
interface LanguageIndicator {
  file: string;
  language: SupportedLanguage;
  /** Higher weight wins when multiple indicators match. */
  weight: number;
}

// ---------------------------------------------------------------------------
// Indicator registry
// ---------------------------------------------------------------------------

const INDICATORS: LanguageIndicator[] = [
  // TypeScript (highest priority among JS/TS)
  { file: "tsconfig.json", language: "typescript", weight: 100 },
  { file: "tsconfig.build.json", language: "typescript", weight: 90 },

  // JavaScript / Node
  { file: "package.json", language: "javascript", weight: 50 },
  { file: "yarn.lock", language: "javascript", weight: 40 },
  { file: "pnpm-lock.yaml", language: "javascript", weight: 40 },

  // Python
  { file: "pyproject.toml", language: "python", weight: 100 },
  { file: "setup.py", language: "python", weight: 90 },
  { file: "requirements.txt", language: "python", weight: 80 },
  { file: "Pipfile", language: "python", weight: 80 },
  { file: "poetry.lock", language: "python", weight: 85 },

  // Rust
  { file: "Cargo.toml", language: "rust", weight: 100 },
  { file: "Cargo.lock", language: "rust", weight: 90 },

  // Go
  { file: "go.mod", language: "go", weight: 100 },
  { file: "go.sum", language: "go", weight: 90 },

  // Java
  { file: "pom.xml", language: "java", weight: 100 },
  { file: "build.gradle", language: "java", weight: 100 },
  { file: "build.gradle.kts", language: "java", weight: 100 },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect the primary language of a project.
 *
 * This performs a lightweight check using the GitHub API (if the repo URL
 * points to GitHub) to list root-level files, then falls back to a simple
 * URL heuristic.
 *
 * In production the detection runs **inside** the VM after cloning; this
 * function is only used as an early hint for VM image selection.
 */
export async function detectLanguage(repoUrl: string): Promise<SupportedLanguage> {
  try {
    // Attempt GitHub API-based detection
    const githubFiles = await fetchGithubRootFiles(repoUrl);
    if (githubFiles.length > 0) {
      const detected = matchIndicators(githubFiles);
      if (detected !== "unknown") {
        logger.info("Language detected via GitHub API", { language: detected });
        return detected;
      }
    }
  } catch {
    // GitHub API unavailable or non-GitHub URL -- fall through
  }

  // Fallback: URL-based heuristic (very rough)
  const urlLower = repoUrl.toLowerCase();
  if (urlLower.includes("typescript") || urlLower.includes("-ts")) return "typescript";
  if (urlLower.includes("python") || urlLower.includes("-py")) return "python";
  if (urlLower.includes("rust") || urlLower.includes("-rs")) return "rust";
  if (urlLower.includes("golang") || urlLower.includes("-go")) return "go";

  logger.warn("Could not detect language; defaulting to unknown", { repoUrl });
  return "unknown";
}

/**
 * Detect language from a list of file names (typically the root of the repo).
 * Used after the repo has been cloned inside the VM.
 */
export function detectLanguageFromFiles(files: string[]): SupportedLanguage {
  return matchIndicators(files);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function matchIndicators(files: string[]): SupportedLanguage {
  const fileSet = new Set(files.map((f) => f.toLowerCase()));
  let best: { language: SupportedLanguage; weight: number } = {
    language: "unknown",
    weight: -1,
  };

  for (const indicator of INDICATORS) {
    if (fileSet.has(indicator.file.toLowerCase())) {
      if (indicator.weight > best.weight) {
        best = { language: indicator.language, weight: indicator.weight };
      }
    }
  }

  return best.language;
}

/**
 * Fetch the list of root-level files from a GitHub repository using the
 * public contents API.  Returns an empty array on failure.
 */
async function fetchGithubRootFiles(repoUrl: string): Promise<string[]> {
  const match = repoUrl.match(
    /github\.com[/:]([^/]+)\/([^/.]+)/,
  );
  if (!match) return [];

  const [, owner, repo] = match;
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(apiUrl, {
      headers: {
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "arcagent-worker",
        ...(process.env.GITHUB_TOKEN
          ? { Authorization: `token ${process.env.GITHUB_TOKEN}` }
          : {}),
      },
      signal: controller.signal,
    });

    if (!response.ok) return [];

    const data = (await response.json()) as Array<{ name: string }>;
    return data.map((item) => item.name);
  } finally {
    clearTimeout(timeout);
  }
}
