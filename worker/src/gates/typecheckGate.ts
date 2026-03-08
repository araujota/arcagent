import { VMHandle } from "../vm/firecracker";
import { GateResult } from "../queue/jobQueue";
import { DiffContext } from "../lib/diffContext";
import { filterToChangedFiles } from "../lib/diffFilter";

/**
 * Type-check gate -- runs the static type checker for the project language.
 *
 * Type checkers need full project context to resolve types, so they always run
 * on the entire project. When DiffContext is available, the output is post-hoc
 * filtered to only report errors in files the agent changed.
 *
 * Supported:
 *  - TypeScript: tsc --noEmit
 *  - Python: pyright or mypy
 *  - Go: go vet
 *  - PHP: PHPStan
 *  - Ruby: Sorbet (if available)
 *  - Rust/Java/C/C++/Swift/Kotlin/C#: covered by build
 */
export async function runTypecheckGate(
  vm: VMHandle,
  language: string,
  timeoutMs: number,
  diff: DiffContext | null,
): Promise<GateResult> {
  const start = Date.now();

  const command = getTypecheckCommand(language);

  if (!command) {
    return {
      gate: "typecheck",
      status: "skipped",
      durationMs: Date.now() - start,
      summary: `No type checker configured for language: ${language}`,
    };
  }

  const result = await vm.exec(
    `cd /workspace && ${command} 2>&1`,
    timeoutMs,
  );

  const durationMs = Date.now() - start;
  const skipSummary = getTypecheckSkipSummary(result.stdout);
  if (result.exitCode === 0 && skipSummary) {
    return {
      gate: "typecheck",
      status: "skipped",
      durationMs,
      summary: skipSummary,
    };
  }

  if (result.exitCode === 0) {
    return {
      gate: "typecheck",
      status: "pass",
      durationMs,
      summary: "Type check passed",
    };
  }

  // Parse error lines
  let errorLines = result.stdout
    .split("\n")
    .filter((line) => /error\s+(TS\d+|E\d+|:)/.test(line));

  // Post-hoc filter to changed files when diff is available
  if (diff && diff.changedFiles.length > 0) {
    const allErrorLines = errorLines;

    errorLines = filterToChangedFiles(
      errorLines,
      (line) => extractFilePath(line),
      diff.changedFiles,
    );

    const filteredOut = allErrorLines.length - errorLines.length;

    if (errorLines.length === 0) {
      return {
        gate: "typecheck",
        status: "pass",
        durationMs,
        summary: `Type check passed (${filteredOut} pre-existing error(s) filtered out)`,
        details: {
          totalErrors: allErrorLines.length,
          filteredErrors: filteredOut,
          diffScoped: true,
        },
      };
    }
  }

  return {
    gate: "typecheck",
    status: "fail",
    durationMs,
    summary: `Type check failed with ${errorLines.length} error(s)`,
    details: {
      exitCode: result.exitCode,
      errorCount: errorLines.length,
      errors: errorLines.slice(0, 20).map((line) => line.trim()),
      rawOutput: truncate(result.stdout, 5_000),
      diffScoped: diff !== null,
    },
  };
}

function getTypecheckSkipSummary(output: string): string | null {
  const firstLine = output.trim().split("\n")[0] ?? "";
  if (firstLine.includes("No type checker available") || firstLine.includes("not available")) {
    return firstLine;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getTypecheckCommand(language: string): string | null {
  switch (language.toLowerCase()) {
    case "typescript":
      return (
        "if [ -x ./node_modules/.bin/tsc ]; then ./node_modules/.bin/tsc --noEmit 2>&1; " +
        "elif command -v tsc >/dev/null 2>&1; then tsc --noEmit 2>&1; " +
        "else echo 'TypeScript compiler not available' && exit 1; fi"
      );
    case "python":
      // Prefer pyright; fall back to mypy
      return (
        "if [ -x ./.venv/bin/pyright ]; then ./.venv/bin/pyright .; " +
        "elif [ -x ./venv/bin/pyright ]; then ./venv/bin/pyright .; " +
        "elif python -m pyright --version >/dev/null 2>&1; then python -m pyright .; " +
        "elif command -v pyright >/dev/null 2>&1; then pyright .; " +
        "elif [ -x ./.venv/bin/mypy ]; then ./.venv/bin/mypy . --ignore-missing-imports; " +
        "elif [ -x ./venv/bin/mypy ]; then ./venv/bin/mypy . --ignore-missing-imports; " +
        "elif python -m mypy --version >/dev/null 2>&1; then python -m mypy . --ignore-missing-imports; " +
        "elif command -v mypy >/dev/null 2>&1; then mypy . --ignore-missing-imports; " +
        "else echo 'No type checker available' && exit 0; fi"
      );
    case "go":
      return "go vet ./... 2>&1";
    case "php":
      return (
        "if [ -x vendor/bin/phpstan ]; then vendor/bin/phpstan analyse --error-format=raw 2>&1; " +
        "elif command -v phpstan >/dev/null 2>&1; then phpstan analyse --error-format=raw 2>&1; " +
        "else echo 'PHPStan not available' && exit 0; fi"
      );
    case "ruby":
      return (
        "if [ -f Gemfile ]; then bundle exec srb tc 2>&1; " +
        "elif command -v srb >/dev/null 2>&1; then srb tc 2>&1; " +
        "else echo 'Sorbet not available' && exit 0; fi"
      );
    case "rust":
    case "java":
    case "csharp":
    case "c":
    case "cpp":
    case "swift":
    case "kotlin":
      // Type checking is part of the build step for these languages
      return null;
    default:
      return null;
  }
}

/**
 * Extract the file path from a type checker error line.
 * Handles formats like:
 *  - TypeScript: "src/foo.ts(10,5): error TS2345: ..."
 *  - Python: "src/foo.py:10: error: ..."
 *  - Go: "src/foo.go:10:5: ..."
 */
function extractFilePath(line: string): string | undefined {
  // TypeScript format: file(line,col): error
  const tsMatch = line.match(/^(.+?)\(\d+,\d+\):/);
  if (tsMatch) return tsMatch[1];

  // Python/Go format: file:line: error
  const pyMatch = line.match(/^(.+?):\d+:/);
  if (pyMatch) return pyMatch[1];

  return undefined;
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "\n... (truncated)";
}
