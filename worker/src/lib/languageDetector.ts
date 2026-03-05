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
  | "ruby"
  | "php"
  | "csharp"
  | "c"
  | "cpp"
  | "swift"
  | "kotlin"
  | "unknown";

/** Indicator file and its associated language. */
interface LanguageIndicator {
  file: string;
  language: SupportedLanguage;
  /** Higher weight wins when multiple indicators match. */
  weight: number;
}

interface WeightedLanguage {
  language: SupportedLanguage;
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

  // Ruby
  { file: "Gemfile", language: "ruby", weight: 100 },
  { file: "Gemfile.lock", language: "ruby", weight: 90 },
  { file: "Rakefile", language: "ruby", weight: 70 },

  // PHP
  { file: "composer.json", language: "php", weight: 100 },
  { file: "composer.lock", language: "php", weight: 90 },

  // C#
  // Note: .csproj/.sln files are detected via extension matching below
  { file: "global.json", language: "csharp", weight: 80 },

  // C/C++
  { file: "CMakeLists.txt", language: "cpp", weight: 100 },
  { file: "Makefile", language: "c", weight: 60 },
  { file: "configure.ac", language: "c", weight: 70 },
  { file: "meson.build", language: "cpp", weight: 80 },

  // Swift
  { file: "Package.swift", language: "swift", weight: 100 },

  // Kotlin (distinguished from Java by specific Kotlin files)
  { file: "build.gradle.kts", language: "kotlin", weight: 95 },
  { file: "settings.gradle.kts", language: "kotlin", weight: 85 },
];

/**
 * Extension-based indicators for files that may have varying names.
 * Used in detectLanguageFromFiles for more thorough detection.
 */
const EXTENSION_INDICATORS: { ext: string; language: SupportedLanguage; weight: number }[] = [
  { ext: ".csproj", language: "csharp", weight: 100 },
  { ext: ".sln", language: "csharp", weight: 90 },
  { ext: ".fsproj", language: "csharp", weight: 95 },
  { ext: ".swift", language: "swift", weight: 80 },
  { ext: ".kt", language: "kotlin", weight: 80 },
  { ext: ".kts", language: "kotlin", weight: 75 },
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
  if (urlLower.includes("ruby") || urlLower.includes("-rb")) return "ruby";
  if (urlLower.includes("csharp") || urlLower.includes("dotnet")) return "csharp";
  if (urlLower.includes("swift")) return "swift";
  if (urlLower.includes("kotlin")) return "kotlin";
  if (urlLower.includes("php")) return "php";

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
  const normalizedFiles = files.map((f) => f.toLowerCase());
  const fileSet = new Set(normalizedFiles);
  let best: WeightedLanguage = {
    language: "unknown",
    weight: -1,
  };

  // Check exact file name indicators
  for (const indicator of INDICATORS) {
    if (!fileSet.has(indicator.file.toLowerCase())) continue;
    best = chooseHigherWeight(best, {
      language: indicator.language,
      weight: indicator.weight,
    });
  }

  // Check extension-based indicators
  for (const file of normalizedFiles) {
    for (const extInd of EXTENSION_INDICATORS) {
      if (!file.endsWith(extInd.ext)) continue;
      best = chooseHigherWeight(best, {
        language: extInd.language,
        weight: extInd.weight,
      });
    }
  }

  return best.language;
}

function chooseHigherWeight(
  current: WeightedLanguage,
  candidate: WeightedLanguage,
): WeightedLanguage {
  return candidate.weight > current.weight ? candidate : current;
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
  const githubToken = process.env.GITHUB_API_TOKEN ?? process.env.GITHUB_TOKEN;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(apiUrl, {
      headers: {
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "arcagent-worker",
        ...(githubToken
          ? { Authorization: `token ${githubToken}` }
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
