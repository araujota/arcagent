import { VMHandle } from "../vm/firecracker";
import { GateResult } from "../queue/jobQueue";
import { parseJsonSafe } from "../lib/resultParser";

/**
 * Test gate -- executes the project's test suite.
 *
 * Supports BDD and TDD frameworks:
 *  - TypeScript / JavaScript: jest, vitest, mocha (with JSON reporter)
 *  - Python: pytest (with JSON output)
 *  - Rust: cargo test (with JSON messages)
 *  - Go: go test (with JSON output)
 *  - Java: mvn test / gradle test
 */
export async function runTestGate(
  vm: VMHandle,
  language: string,
  timeoutMs: number,
): Promise<GateResult> {
  const start = Date.now();

  const command = getTestCommand(language);

  if (!command) {
    return {
      gate: "test",
      status: "skipped",
      durationMs: Date.now() - start,
      summary: `No test runner configured for language: ${language}`,
    };
  }

  const result = await vm.exec(
    `cd /workspace && ${command} 2>&1`,
    timeoutMs,
  );

  const durationMs = Date.now() - start;

  // Parse test results
  const parsed = parseTestOutput(language, result.stdout);

  if (result.exitCode === 0) {
    return {
      gate: "test",
      status: "pass",
      durationMs,
      summary: parsed
        ? `All tests passed (${parsed.passed} passed, ${parsed.total} total)`
        : "All tests passed",
      details: {
        ...parsed,
        exitCode: 0,
      },
    };
  }

  return {
    gate: "test",
    status: "fail",
    durationMs,
    summary: parsed
      ? `Tests failed: ${parsed.failed} of ${parsed.total} test(s) failed`
      : `Test runner exited with code ${result.exitCode}`,
    details: {
      exitCode: result.exitCode,
      ...parsed,
      rawOutput: truncate(result.stdout, 10_000),
    },
  };
}

// ---------------------------------------------------------------------------
// Test commands
// ---------------------------------------------------------------------------

function getTestCommand(language: string): string | null {
  switch (language.toLowerCase()) {
    case "typescript":
    case "javascript":
      // Detect test runner and use JSON reporter
      return (
        "if [ -f vitest.config.ts ] || [ -f vitest.config.js ]; then " +
        "  npx vitest run --reporter=json --outputFile=/tmp/test-result.json 2>&1; " +
        "  cat /tmp/test-result.json; " +
        "elif npx jest --version &>/dev/null; then " +
        "  npx jest --json --outputFile=/tmp/test-result.json 2>&1; " +
        "  cat /tmp/test-result.json; " +
        "elif [ -f .mocharc.yml ] || [ -f .mocharc.json ]; then " +
        "  npx mocha --reporter json 2>&1; " +
        "else " +
        "  npm test 2>&1; " +
        "fi"
      );
    case "python":
      return (
        "if command -v pytest &>/dev/null; then " +
        "  pytest --tb=short -q --json-report --json-report-file=/tmp/test-result.json 2>&1; " +
        "  cat /tmp/test-result.json; " +
        "else " +
        "  python -m unittest discover -v 2>&1; " +
        "fi"
      );
    case "rust":
      return "cargo test -- -Z unstable-options --format json 2>&1";
    case "go":
      return "go test -v -json ./... 2>&1";
    case "java":
      return (
        "if [ -f pom.xml ]; then mvn test -q 2>&1; " +
        "elif [ -f build.gradle ] || [ -f build.gradle.kts ]; then gradle test 2>&1; " +
        "else echo 'No test runner found' && exit 0; fi"
      );
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

interface TestSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  duration?: number;
  suites?: number;
  failures?: TestFailure[];
}

interface TestFailure {
  name: string;
  message: string;
}

function parseTestOutput(
  language: string,
  output: string,
): TestSummary | null {
  switch (language.toLowerCase()) {
    case "typescript":
    case "javascript":
      return parseJestVitest(output);
    case "python":
      return parsePytest(output);
    case "go":
      return parseGoTest(output);
    default:
      return null;
  }
}

/** Parse Jest or Vitest JSON output. */
function parseJestVitest(output: string): TestSummary | null {
  const parsed = parseJsonSafe<JestOutput>(output);
  if (!parsed) return null;

  const failures: TestFailure[] = [];
  for (const suite of parsed.testResults ?? []) {
    for (const test of suite.assertionResults ?? []) {
      if (test.status === "failed") {
        failures.push({
          name: test.fullName ?? test.title ?? "unknown",
          message: (test.failureMessages ?? []).join("\n").slice(0, 500),
        });
      }
    }
  }

  return {
    total: parsed.numTotalTests ?? 0,
    passed: parsed.numPassedTests ?? 0,
    failed: parsed.numFailedTests ?? 0,
    skipped: (parsed.numPendingTests ?? 0) + (parsed.numTodoTests ?? 0),
    suites: parsed.numTotalTestSuites ?? 0,
    failures: failures.slice(0, 20),
  };
}

interface JestOutput {
  numTotalTests?: number;
  numPassedTests?: number;
  numFailedTests?: number;
  numPendingTests?: number;
  numTodoTests?: number;
  numTotalTestSuites?: number;
  testResults?: {
    assertionResults?: {
      status?: string;
      title?: string;
      fullName?: string;
      failureMessages?: string[];
    }[];
  }[];
}

/** Parse pytest JSON report. */
function parsePytest(output: string): TestSummary | null {
  const parsed = parseJsonSafe<PytestReport>(output);
  if (!parsed?.summary) return null;

  return {
    total: parsed.summary.total ?? 0,
    passed: parsed.summary.passed ?? 0,
    failed: parsed.summary.failed ?? 0,
    skipped: parsed.summary.skipped ?? 0,
    duration: parsed.summary.duration,
  };
}

interface PytestReport {
  summary?: {
    total?: number;
    passed?: number;
    failed?: number;
    skipped?: number;
    duration?: number;
  };
}

/** Parse Go test JSON output (line-delimited JSON). */
function parseGoTest(output: string): TestSummary | null {
  const lines = output.split("\n").filter((l) => l.trim());
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const line of lines) {
    const event = parseJsonSafe<GoTestEvent>(line);
    if (!event || !event.Action) continue;

    switch (event.Action) {
      case "pass":
        if (event.Test) passed++;
        break;
      case "fail":
        if (event.Test) failed++;
        break;
      case "skip":
        if (event.Test) skipped++;
        break;
    }
  }

  const total = passed + failed + skipped;
  if (total === 0) return null;

  return { total, passed, failed, skipped };
}

interface GoTestEvent {
  Action?: string;
  Test?: string;
  Package?: string;
  Elapsed?: number;
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "\n... (truncated)";
}
