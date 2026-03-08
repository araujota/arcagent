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
  void _diff;
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
      return (
        "if [ -f yarn.lock ]; then " +
        "  if command -v yarn >/dev/null 2>&1; then yarn install --frozen-lockfile; " +
        "  else corepack yarn install --frozen-lockfile; fi; " +
        "elif [ -f pnpm-lock.yaml ]; then " +
        "  if command -v pnpm >/dev/null 2>&1; then pnpm install --frozen-lockfile; " +
        "  else corepack pnpm install --frozen-lockfile; fi; " +
        "elif [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then " +
        "  npm ci; " +
        "elif [ -f package.json ]; then " +
        "  npm install --no-audit --no-fund; " +
        "else echo 'No package.json found' && exit 0; fi && " +
        "if node -e \"const p=require('./package.json');process.exit(p.scripts&&p.scripts.build?0:1)\" >/dev/null 2>&1; then " +
        "  npm run build; " +
        "elif [ -f tsconfig.json ]; then " +
        "  if [ -x ./node_modules/.bin/tsc ]; then ./node_modules/.bin/tsc --noEmit; " +
        "  elif command -v tsc >/dev/null 2>&1; then tsc --noEmit; " +
        "  else echo 'TypeScript compiler not available' && exit 1; fi; " +
        "else echo 'Dependencies installed (no build script configured)'; fi"
      );
    case "python":
      return (
        "if [ -f poetry.lock ]; then poetry install --no-interaction; " +
        "elif [ -f Pipfile.lock ]; then pipenv install --deploy; " +
        "elif [ -f requirements.txt ]; then pip install -r requirements.txt; " +
        "elif [ -f pyproject.toml ]; then pip install .; " +
        "else echo 'No dependency file found' && exit 0; fi"
      );
    case "rust":
      return "cargo build --release 2>&1";
    case "go":
      return "go build ./... 2>&1";
    case "java":
      return (
        "if [ -x ./mvnw ]; then ./mvnw -q -DskipTests compile; " +
        "elif [ -f pom.xml ]; then mvn -q -DskipTests compile; " +
        "elif [ -x ./gradlew ]; then ./gradlew build -x test; " +
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
        "if [ -x ./gradlew ]; then ./gradlew build -x test; " +
        "elif [ -f build.gradle.kts ] || [ -f build.gradle ]; then gradle build -x test; " +
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
