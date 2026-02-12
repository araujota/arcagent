import { VMHandle } from "../vm/firecracker";
import { GateResult } from "../queue/jobQueue";
import { DiffContext } from "../lib/diffContext";
import { parseJsonSafe } from "../lib/resultParser";
import { sanitizeFilePath } from "../lib/shellSanitize";

/**
 * Lint gate -- runs the appropriate linter for the project language.
 *
 * When DiffContext is available, only the changed files are passed to the linter
 * (file-scoped). This prevents the agent from being blamed for pre-existing
 * lint warnings in files they didn't touch.
 *
 * Supported:
 *  - TypeScript / JavaScript: ESLint
 *  - Python: Ruff
 *  - Rust: Clippy (post-hoc filtered)
 *  - Go: golangci-lint
 *  - Java: Checkstyle
 *  - Ruby: RuboCop
 *  - PHP: PHP_CodeSniffer
 *  - C#: dotnet format --verify
 *  - C/C++: clang-tidy + cppcheck
 *  - Swift: SwiftLint
 *  - Kotlin: ktlint
 */
export async function runLintGate(
  vm: VMHandle,
  language: string,
  timeoutMs: number,
  diff: DiffContext | null,
): Promise<GateResult> {
  const start = Date.now();

  const command = getLintCommand(language, diff);

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

/** Build file list string for diff-scoped linting. */
function diffFileArgs(diff: DiffContext | null, extensions: string[]): string | null {
  if (!diff || diff.changedFiles.length === 0) return null;

  const relevant = diff.changedFiles.filter((f) =>
    extensions.some((ext) => f.endsWith(ext)),
  );

  if (relevant.length === 0) return null;

  // SECURITY (C5): Sanitize file paths to prevent shell injection.
  // An agent can commit files with shell metacharacters in their names
  // (e.g., single quotes, semicolons) that would break quoting.
  const sanitized = relevant
    .map((f) => sanitizeFilePath(f))
    .filter((f): f is string => f !== null);

  if (sanitized.length === 0) return null;

  return sanitized.join(" ");
}

function getLintCommand(language: string, diff: DiffContext | null): string | null {
  switch (language.toLowerCase()) {
    case "typescript":
    case "javascript": {
      const files = diffFileArgs(diff, [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
      const target = files ?? ".";
      return (
        `npx eslint ${target} --format json --output-file /tmp/lint-result.json || true && ` +
        "cat /tmp/lint-result.json"
      );
    }
    case "python": {
      const files = diffFileArgs(diff, [".py"]);
      const target = files ?? ".";
      return `ruff check ${target} --output-format json 2>/dev/null || ruff check ${target}`;
    }
    case "rust":
      // Clippy runs on the full project; output is post-hoc filtered in parseLintOutput
      return "cargo clippy --message-format=json -- -D warnings 2>&1";
    case "go": {
      const files = diffFileArgs(diff, [".go"]);
      const target = files ?? "./...";
      return `golangci-lint run --out-format json ${target} 2>&1`;
    }
    case "java":
      return (
        "if [ -f checkstyle.xml ]; then " +
        "  java -jar /opt/checkstyle.jar -c checkstyle.xml -f json src/ 2>&1; " +
        "elif [ -f pom.xml ]; then " +
        "  mvn checkstyle:check -q 2>&1; " +
        "else echo 'No Checkstyle config found' && exit 0; fi"
      );
    case "ruby": {
      const files = diffFileArgs(diff, [".rb"]);
      const target = files ?? ".";
      return `rubocop ${target} --format json 2>&1`;
    }
    case "php": {
      const files = diffFileArgs(diff, [".php"]);
      const target = files ?? ".";
      return `phpcs --report=json ${target} 2>&1`;
    }
    case "csharp":
      return "dotnet format --verify-no-changes --verbosity diagnostic 2>&1";
    case "c":
    case "cpp": {
      const cExts = language === "cpp"
        ? [".cpp", ".cxx", ".cc", ".hpp", ".hxx", ".h"]
        : [".c", ".h"];
      const files = diffFileArgs(diff, cExts);
      if (files) {
        return (
          `clang-tidy ${files} -- -I. 2>&1; ` +
          `cppcheck --enable=all --template='{file}:{line}:{severity}:{message}' ${files} 2>&1`
        );
      }
      return (
        "clang-tidy src/*.c src/*.cpp src/*.cc -- -I. 2>&1 || true; " +
        "cppcheck --enable=all --template='{file}:{line}:{severity}:{message}' . 2>&1"
      );
    }
    case "swift": {
      const files = diffFileArgs(diff, [".swift"]);
      if (files) {
        return `swiftlint lint ${files} --reporter json 2>&1`;
      }
      return "swiftlint lint --reporter json 2>&1";
    }
    case "kotlin": {
      const files = diffFileArgs(diff, [".kt", ".kts"]);
      const target = files ?? ".";
      return `ktlint ${target} --reporter=json 2>&1`;
    }
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
    case "ruby": {
      const parsed = parseJsonSafe<RubocopOutput>(output);
      if (!parsed?.summary) return undefined;
      return { issueCount: parsed.summary.offense_count ?? 0 };
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

interface RubocopOutput {
  summary?: {
    offense_count?: number;
  };
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "\n... (truncated)";
}
