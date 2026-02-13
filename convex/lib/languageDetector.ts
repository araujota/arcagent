/**
 * Language detection from file extensions and manifest files.
 * Maps file extensions to tree-sitter language identifiers.
 */

export type SupportedLanguage =
  | "typescript"
  | "javascript"
  | "python"
  | "go"
  | "rust"
  | "java"
  | "c"
  | "cpp"
  | "csharp"
  | "ruby"
  | "php"
  | "swift"
  | "kotlin"
  | "scala"
  | "unknown";

// Extension to language mapping
const EXTENSION_MAP: Record<string, SupportedLanguage> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".pyi": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".cc": "cpp",
  ".hh": "cpp",
  ".cs": "csharp",
  ".rb": "ruby",
  ".php": "php",
  ".swift": "swift",
  ".kt": "kotlin",
  ".scala": "scala",
};

// Manifest files that indicate the primary language
const MANIFEST_LANGUAGE_MAP: Record<string, SupportedLanguage> = {
  "package.json": "typescript", // assume TS for Node projects (most common now)
  "tsconfig.json": "typescript",
  "jsconfig.json": "javascript",
  "pyproject.toml": "python",
  "setup.py": "python",
  "requirements.txt": "python",
  "Pipfile": "python",
  "go.mod": "go",
  "Cargo.toml": "rust",
  "pom.xml": "java",
  "build.gradle": "java",
  "build.gradle.kts": "kotlin",
  "Gemfile": "ruby",
  "composer.json": "php",
  "Package.swift": "swift",
  "build.sbt": "scala",
};

// BDD framework mapping per language
export const BDD_FRAMEWORK_MAP: Record<
  string,
  { framework: string; runner: string; configFile: string }
> = {
  typescript: {
    framework: "cucumber-js",
    runner: "vitest",
    configFile: "cucumber.js",
  },
  javascript: {
    framework: "cucumber-js",
    runner: "jest",
    configFile: "cucumber.js",
  },
  python: {
    framework: "pytest-bdd",
    runner: "pytest",
    configFile: "pytest.ini",
  },
  go: { framework: "godog", runner: "go test", configFile: "godog.go" },
  rust: {
    framework: "cucumber-rs",
    runner: "cargo test",
    configFile: "tests/cucumber.rs",
  },
  java: {
    framework: "cucumber-jvm",
    runner: "junit5",
    configFile: "src/test/resources/cucumber.properties",
  },
  ruby: {
    framework: "cucumber",
    runner: "cucumber",
    configFile: "cucumber.yml",
  },
  php: {
    framework: "behat",
    runner: "behat",
    configFile: "behat.yml",
  },
  csharp: {
    framework: "reqnroll",
    runner: "dotnet test",
    configFile: "reqnroll.json",
  },
  kotlin: {
    framework: "cucumber-jvm",
    runner: "gradle test",
    configFile: "src/test/resources/cucumber.properties",
  },
  c: {
    framework: "ctest-bdd",
    runner: "ctest",
    configFile: "CMakeLists.txt",
  },
  cpp: {
    framework: "ctest-bdd",
    runner: "ctest",
    configFile: "CMakeLists.txt",
  },
  swift: {
    framework: "xctest-gherkin",
    runner: "swift test",
    configFile: "Package.swift",
  },
};

// Build commands per language
export const BUILD_COMMANDS: Record<
  string,
  { install: string; build: string; lockfile: string }
> = {
  typescript: {
    install: "npm ci",
    build: "npx tsc --noEmit",
    lockfile: "package-lock.json",
  },
  javascript: {
    install: "npm ci",
    build: "npm run build",
    lockfile: "package-lock.json",
  },
  python: {
    install: "pip install -r requirements.txt",
    build: "python -m py_compile",
    lockfile: "requirements.txt",
  },
  go: {
    install: "go mod download",
    build: "go build ./...",
    lockfile: "go.sum",
  },
  rust: {
    install: "cargo fetch",
    build: "cargo build",
    lockfile: "Cargo.lock",
  },
  java: {
    install: "mvn dependency:resolve",
    build: "mvn compile",
    lockfile: "pom.xml",
  },
};

// Lint tool configs per language
export const LINT_CONFIGS: Record<
  string,
  { tool: string; command: string; outputFormat: string }
> = {
  typescript: {
    tool: "eslint",
    command: "npx eslint . --format json",
    outputFormat: "json",
  },
  javascript: {
    tool: "eslint",
    command: "npx eslint . --format json",
    outputFormat: "json",
  },
  python: {
    tool: "ruff",
    command: "ruff check --output-format json .",
    outputFormat: "json",
  },
  go: {
    tool: "golangci-lint",
    command: "golangci-lint run --out-format json",
    outputFormat: "json",
  },
  rust: {
    tool: "clippy",
    command: "cargo clippy --message-format=json -- -D warnings",
    outputFormat: "json",
  },
  java: {
    tool: "checkstyle",
    command: "mvn checkstyle:check",
    outputFormat: "xml",
  },
};

// Typecheck commands per language
export const TYPECHECK_CONFIGS: Record<
  string,
  { tool: string; command: string }
> = {
  typescript: { tool: "tsc", command: "npx tsc --noEmit --strict" },
  python: { tool: "pyright", command: "pyright --outputjson" },
  go: { tool: "go vet", command: "go vet ./..." },
  rust: { tool: "cargo build", command: "cargo build" },
  java: { tool: "javac", command: "mvn compile" },
};

/**
 * Detect language from a file path's extension.
 */
export function detectLanguageFromPath(filePath: string): SupportedLanguage {
  const lastDot = filePath.lastIndexOf(".");
  if (lastDot === -1) return "unknown";

  const ext = filePath.slice(lastDot).toLowerCase();
  return EXTENSION_MAP[ext] || "unknown";
}

/**
 * Detect the primary language of a repository from its file list.
 * Returns the most common language and all detected languages.
 */
export function detectRepoLanguages(filePaths: string[]): {
  primary: SupportedLanguage;
  all: SupportedLanguage[];
  counts: Record<string, number>;
} {
  const counts: Record<string, number> = {};

  for (const path of filePaths) {
    const lang = detectLanguageFromPath(path);
    if (lang !== "unknown") {
      counts[lang] = (counts[lang] || 0) + 1;
    }
  }

  const sorted = Object.entries(counts).sort(([, a], [, b]) => b - a);
  const all = sorted.map(([lang]) => lang as SupportedLanguage);
  const primary = all[0] || "unknown";

  return { primary, all, counts };
}

/**
 * Detect primary language from manifest files present in the repo.
 */
export function detectLanguageFromManifests(
  filePaths: string[]
): SupportedLanguage | null {
  const rootFiles = filePaths
    .filter((p) => !p.includes("/"))
    .map((p) => p.split("/").pop() || "");

  for (const file of rootFiles) {
    if (MANIFEST_LANGUAGE_MAP[file]) {
      return MANIFEST_LANGUAGE_MAP[file];
    }
  }

  return null;
}

/**
 * Detect the package manager used by the project.
 */
export function detectPackageManager(
  filePaths: string[]
): string | null {
  const rootFiles = new Set(
    filePaths.filter((p) => !p.includes("/")).map((p) => p.split("/").pop() || "")
  );

  if (rootFiles.has("pnpm-lock.yaml")) return "pnpm";
  if (rootFiles.has("yarn.lock")) return "yarn";
  if (rootFiles.has("bun.lockb")) return "bun";
  if (rootFiles.has("package-lock.json")) return "npm";
  if (rootFiles.has("Pipfile.lock")) return "pipenv";
  if (rootFiles.has("poetry.lock")) return "poetry";
  if (rootFiles.has("Cargo.lock")) return "cargo";
  if (rootFiles.has("go.sum")) return "go";
  if (rootFiles.has("Gemfile.lock")) return "bundler";
  if (rootFiles.has("composer.lock")) return "composer";

  return null;
}

/**
 * Get the tree-sitter WASM grammar filename for a language.
 */
export function getTreeSitterGrammar(
  language: SupportedLanguage
): string | null {
  const grammarMap: Record<string, string> = {
    typescript: "tree-sitter-typescript.wasm",
    javascript: "tree-sitter-javascript.wasm",
    python: "tree-sitter-python.wasm",
    go: "tree-sitter-go.wasm",
    rust: "tree-sitter-rust.wasm",
    java: "tree-sitter-java.wasm",
    c: "tree-sitter-c.wasm",
    cpp: "tree-sitter-cpp.wasm",
  };

  return grammarMap[language] || null;
}
