import { VMHandle } from "../vm/firecracker";
import { GateResult } from "../queue/jobQueue";
import { DiffContext } from "../lib/diffContext";
import { parseCommandOutput } from "../lib/resultParser";

/**
 * Build gate -- installs dependencies and compiles the project.
 *
 * Always runs on the full project (builds need all dependencies to resolve).
 *
 * Supported languages:
 *  - TypeScript / JavaScript: npm ci / yarn / pnpm
 *  - Python: pip / poetry / pipenv
 *  - Rust: cargo build --release
 *  - Go: go build ./...
 *  - Java: mvn compile / gradle build
 *  - Ruby: bundle install
 *  - PHP: composer install
 *  - C#: dotnet build
 *  - C/C++: cmake / make / gcc
 *  - Swift: swift build
 *  - Kotlin: gradle build
 */
export async function runBuildGate(
  vm: VMHandle,
  language: string,
  timeoutMs: number,
  _diff: DiffContext | null,
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
    case "ruby":
      return (
        "if [ -f Gemfile ]; then bundle install; " +
        "else echo 'No Gemfile found'; fi"
      );
    case "php":
      return (
        "if [ -f composer.json ]; then composer install --no-interaction; " +
        "else echo 'No composer.json found'; fi"
      );
    case "csharp":
      return "dotnet build 2>&1";
    case "c":
      return (
        "if [ -f CMakeLists.txt ]; then cmake -B build && cmake --build build; " +
        "elif [ -f Makefile ]; then make; " +
        "else gcc -o main *.c 2>&1; fi"
      );
    case "cpp":
      return (
        "if [ -f CMakeLists.txt ]; then cmake -B build && cmake --build build; " +
        "elif [ -f Makefile ]; then make; " +
        "else g++ -o main *.cpp 2>&1; fi"
      );
    case "swift":
      return "swift build 2>&1";
    case "kotlin":
      return (
        "if [ -f build.gradle.kts ] || [ -f build.gradle ]; then gradle build -x test; " +
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
