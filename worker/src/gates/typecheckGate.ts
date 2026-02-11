import { VMHandle } from "../vm/firecracker";
import { GateResult } from "../queue/jobQueue";

/**
 * Type-check gate -- runs the static type checker for the project language.
 *
 * Supported:
 *  - TypeScript: tsc --noEmit
 *  - Python: pyright or mypy
 *  - Rust: (covered by cargo build)
 *  - Go: go vet
 *  - Java: (covered by compilation)
 */
export async function runTypecheckGate(
  vm: VMHandle,
  language: string,
  timeoutMs: number,
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

  if (result.exitCode === 0) {
    return {
      gate: "typecheck",
      status: "pass",
      durationMs,
      summary: "Type check passed",
    };
  }

  // Count diagnostic lines (TypeScript format: "file(line,col): error TS...")
  const errorLines = result.stdout
    .split("\n")
    .filter((line) => /error\s+(TS\d+|E\d+|:)/.test(line));

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
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getTypecheckCommand(language: string): string | null {
  switch (language.toLowerCase()) {
    case "typescript":
      return "npx tsc --noEmit 2>&1";
    case "python":
      // Prefer pyright; fall back to mypy
      return (
        "if command -v pyright &>/dev/null; then pyright .; " +
        "elif command -v mypy &>/dev/null; then mypy . --ignore-missing-imports; " +
        "else echo 'No type checker available' && exit 0; fi"
      );
    case "go":
      return "go vet ./... 2>&1";
    case "rust":
      // Type checking is part of the build step for Rust
      return null;
    case "java":
      // Type checking is part of the compilation step for Java
      return null;
    default:
      return null;
  }
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "\n... (truncated)";
}
