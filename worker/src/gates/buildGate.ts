import { VMHandle } from "../vm/firecracker";
import { GateResult } from "../queue/jobQueue";
import { parseCommandOutput } from "../lib/resultParser";

/**
 * Build gate -- installs dependencies and compiles the project.
 *
 * Supported languages:
 *  - TypeScript / JavaScript: `npm ci` (or `yarn install --frozen-lockfile`)
 *  - Python: `pip install -r requirements.txt` (or `poetry install`)
 *  - Rust: `cargo build --release`
 *  - Go: `go build ./...`
 *  - Java: `mvn compile` or `gradle build`
 */
export async function runBuildGate(
  vm: VMHandle,
  language: string,
  timeoutMs: number,
): Promise<GateResult> {
  const start = Date.now();

  const command = getBuildCommand(language);

  if (!command) {
    return {
      gate: "build",
      status: "skipped",
      durationMs: Date.now() - start,
      summary: `No build command configured for language: ${language}`,
    };
  }

  const result = await vm.exec(
    `cd /workspace && ${command} 2>&1`,
    timeoutMs,
  );

  const durationMs = Date.now() - start;

  if (result.exitCode === 0) {
    return {
      gate: "build",
      status: "pass",
      durationMs,
      summary: "Build succeeded",
      details: parseCommandOutput(result.stdout),
    };
  }

  return {
    gate: "build",
    status: "fail",
    durationMs,
    summary: `Build failed with exit code ${result.exitCode}`,
    details: {
      exitCode: result.exitCode,
      stderr: truncate(result.stderr, 5_000),
      stdout: truncate(result.stdout, 5_000),
    },
  };
}

function getBuildCommand(language: string): string | null {
  switch (language.toLowerCase()) {
    case "typescript":
    case "javascript":
      // Detect package manager by lockfile presence
      return (
        "if [ -f yarn.lock ]; then yarn install --frozen-lockfile; " +
        "elif [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile; " +
        "else npm ci; fi"
      );
    case "python":
      return (
        "if [ -f poetry.lock ]; then poetry install --no-interaction; " +
        "elif [ -f Pipfile.lock ]; then pipenv install --deploy; " +
        "elif [ -f requirements.txt ]; then pip install -r requirements.txt; " +
        "else echo 'No dependency file found'; fi"
      );
    case "rust":
      return "cargo build --release 2>&1";
    case "go":
      return "go build ./... 2>&1";
    case "java":
      return (
        "if [ -f pom.xml ]; then mvn compile -q; " +
        "elif [ -f build.gradle ] || [ -f build.gradle.kts ]; then gradle build -x test; " +
        "else echo 'No build file found'; fi"
      );
    default:
      return null;
  }
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + `\n... (truncated, ${text.length} bytes total)`;
}
