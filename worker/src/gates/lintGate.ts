import { VMHandle } from "../vm/firecracker";
import { GateResult } from "../queue/jobQueue";
import { parseJsonSafe } from "../lib/resultParser";

/**
 * Lint gate -- runs the appropriate linter for the project language.
 *
 * Supported:
 *  - TypeScript / JavaScript: eslint with JSON formatter
 *  - Python: ruff check with JSON output
 *  - Rust: clippy with JSON messages
 *  - Go: golangci-lint
 */
export async function runLintGate(
  vm: VMHandle,
  language: string,
  timeoutMs: number,
): Promise<GateResult> {
  const start = Date.now();

  const command = getLintCommand(language);

  if (!command) {
    return {
      gate: "lint",
      status: "skipped",
      durationMs: Date.now() - start,
      summary: `No linter configured for language: ${language}`,
    };
  }

  const result = await vm.exec(
    `cd /workspace && ${command} 2>&1`,
    timeoutMs,
  );

  const durationMs = Date.now() - start;

  // Most linters exit 0 on success, non-zero when issues are found
  if (result.exitCode === 0) {
    return {
      gate: "lint",
      status: "pass",
      durationMs,
      summary: "Lint passed with no issues",
      details: parseLintOutput(language, result.stdout),
    };
  }

  const parsedOutput = parseLintOutput(language, result.stdout);
  const issueCount =
    typeof parsedOutput?.issueCount === "number"
      ? parsedOutput.issueCount
      : "unknown";

  return {
    gate: "lint",
    status: "fail",
    durationMs,
    summary: `Lint found ${issueCount} issue(s)`,
    details: {
      exitCode: result.exitCode,
      ...parsedOutput,
      rawOutput: truncate(result.stdout, 3_000),
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getLintCommand(language: string): string | null {
  switch (language.toLowerCase()) {
    case "typescript":
    case "javascript":
      return (
        "npx eslint . --format json --output-file /tmp/lint-result.json || true && " +
        "cat /tmp/lint-result.json"
      );
    case "python":
      return "ruff check . --output-format json 2>/dev/null || ruff check .";
    case "rust":
      return "cargo clippy --message-format=json -- -D warnings 2>&1";
    case "go":
      return "golangci-lint run --out-format json ./... 2>&1";
    default:
      return null;
  }
}

function parseLintOutput(
  language: string,
  output: string,
): Record<string, unknown> | undefined {
  switch (language.toLowerCase()) {
    case "typescript":
    case "javascript": {
      const parsed = parseJsonSafe<EslintResult[]>(output);
      if (!parsed) return undefined;
      const issues = parsed.reduce(
        (sum, file) => sum + (file.errorCount ?? 0) + (file.warningCount ?? 0),
        0,
      );
      return { issueCount: issues, files: parsed.length };
    }
    case "python": {
      const parsed = parseJsonSafe<RuffIssue[]>(output);
      if (!parsed) return undefined;
      return { issueCount: parsed.length };
    }
    default:
      return undefined;
  }
}

interface EslintResult {
  filePath?: string;
  errorCount?: number;
  warningCount?: number;
}

interface RuffIssue {
  code?: string;
  message?: string;
  filename?: string;
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "\n... (truncated)";
}
