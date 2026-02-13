import { VMHandle } from "../vm/firecracker";
import { GateResult, StepResult, TestSuiteInput } from "../queue/jobQueue";
import { DiffContext } from "../lib/diffContext";
import { parseJsonSafe } from "../lib/resultParser";
import { logger } from "../index";

/**
 * Test gate -- executes the project's test suite.
 *
 * Always runs on the full project (not diff-scoped) to catch regressions.
 *
 * Supports BDD and TDD frameworks:
 *  - TypeScript / JavaScript: jest, vitest, mocha
 *  - Python: pytest, unittest
 *  - Rust: cargo test
 *  - Go: go test
 *  - Java: mvn test / gradle test
 *  - Ruby: rspec / minitest
 *  - PHP: PHPUnit
 *  - C#: dotnet test
 *  - C/C++: ctest
 *  - Swift: swift test
 *  - Kotlin: gradle test
 */
export async function runTestGate(
  vm: VMHandle,
  language: string,
  timeoutMs: number,
  _diff: DiffContext | null,
  testSuites?: TestSuiteInput[],
  stepDefinitionsPublic?: string,
  stepDefinitionsHidden?: string,
): Promise<GateResult> {
  const start = Date.now();

  // If test suites with visibility are provided, run them separately
  // to tag each result with public/hidden visibility.
  if (testSuites && testSuites.length > 0) {
    return runTaggedBddTests(
      vm, language, timeoutMs, testSuites, start,
      stepDefinitionsPublic, stepDefinitionsHidden,
    );
  }

  // Fallback: run the project's own test suite (no visibility tagging)
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

/**
 * Run BDD test suites separately by visibility (public first, then hidden),
 * tagging each step result with its source visibility.
 */
async function runTaggedBddTests(
  vm: VMHandle,
  language: string,
  timeoutMs: number,
  testSuites: TestSuiteInput[],
  start: number,
  stepDefinitionsPublic?: string,
  stepDefinitionsHidden?: string,
): Promise<GateResult> {
  const allSteps: StepResult[] = [];
  let stepCounter = 0;
  let overallFailed = false;

  // SECURITY: Inject step definitions into root-owned directory in the VM.
  // The agent user cannot read /run/bdd_steps/ directly.
  const stepDefsDir = "/run/bdd_steps";
  await vm.exec(`mkdir -p ${stepDefsDir} && chmod 700 ${stepDefsDir}`, 5_000);

  const injectStepDefs = async (stepDefsJson: string | undefined, label: string) => {
    if (!stepDefsJson) return;
    try {
      const files = JSON.parse(stepDefsJson);
      if (!Array.isArray(files)) return;
      for (const file of files) {
        if (file.path && file.content) {
          const targetPath = `${stepDefsDir}/${label}_${file.path.replace(/\//g, "_")}`;
          if (vm.writeFile) {
            await vm.writeFile(
              targetPath,
              Buffer.from(file.content, "utf-8"),
              "0400",
              "root:root",
            );
          } else {
            const b64 = Buffer.from(file.content).toString("base64");
            await vm.exec(
              `echo '${b64}' | base64 -d > ${targetPath} && chmod 0400 ${targetPath} && chown root:root ${targetPath}`,
              5_000,
            );
          }
        }
      }
    } catch (err) {
      logger.warn(`Failed to inject ${label} step definitions`, { error: String(err) });
    }
  };

  await injectStepDefs(stepDefinitionsPublic, "public");
  await injectStepDefs(stepDefinitionsHidden, "hidden");

  const publicSuites = testSuites.filter((ts) => ts.visibility === "public");
  const hiddenSuites = testSuites.filter((ts) => ts.visibility === "hidden");

  // Run public suites first, then hidden
  for (const group of [
    { suites: publicSuites, visibility: "public" as const },
    { suites: hiddenSuites, visibility: "hidden" as const },
  ]) {
    for (const suite of group.suites) {
      // Write feature file to the VM using base64 to prevent injection.
      const featurePath = `/tmp/bdd_${group.visibility}_${stepCounter}.feature`;
      const b64 = Buffer.from(suite.gherkinContent).toString("base64");
      await vm.exec(
        `echo '${b64}' | base64 -d > ${featurePath}`,
        5_000,
      );

      // Run the test for this feature
      const command = getBddTestCommand(language, featurePath);
      if (!command) continue;

      const result = await vm.exec(
        `cd /workspace && ${command} 2>&1`,
        timeoutMs,
      );

      const featureName = suite.title;
      const scenarios = parseScenarios(suite.gherkinContent);

      if (result.exitCode === 0) {
        for (const scenario of scenarios) {
          allSteps.push({
            scenarioName: scenario,
            featureName,
            status: "pass",
            executionTimeMs: 0,
            stepNumber: stepCounter++,
            visibility: group.visibility,
          });
        }
      } else {
        overallFailed = true;
        // Return verbose output so agents see full error messages and stack traces
        for (const scenario of scenarios) {
          allSteps.push({
            scenarioName: scenario,
            featureName,
            status: "fail",
            executionTimeMs: 0,
            output: truncate(result.stdout, 5_000),
            stepNumber: stepCounter++,
            visibility: group.visibility,
          });
        }
      }
    }
  }

  // SECURITY: Delete step definition files immediately after test execution
  await vm.exec(`rm -rf ${stepDefsDir}`, 5_000).catch(() => {});

  const durationMs = Date.now() - start;
  const passed = allSteps.filter((s) => s.status === "pass").length;
  const failed = allSteps.filter((s) => s.status === "fail").length;

  return {
    gate: "test",
    status: overallFailed ? "fail" : "pass",
    durationMs,
    summary: overallFailed
      ? `Tests failed: ${failed} of ${allSteps.length} scenario(s) failed`
      : `All tests passed (${passed} passed, ${allSteps.length} total)`,
    details: {
      total: allSteps.length,
      passed,
      failed,
      exitCode: overallFailed ? 1 : 0,
    },
    steps: allSteps,
  };
}

/**
 * Get the BDD test runner command for a specific feature file.
 */
function getBddTestCommand(language: string, featurePath: string): string | null {
  switch (language.toLowerCase()) {
    case "typescript":
    case "javascript":
      return (
        `if npx cucumber-js --version &>/dev/null; then ` +
        `  npx cucumber-js ${featurePath} --format json 2>&1; ` +
        `elif npx jest --version &>/dev/null; then ` +
        `  npx jest --testPathPattern='.*' --json 2>&1; ` +
        `else npm test 2>&1; fi`
      );
    case "python":
      return `if command -v behave &>/dev/null; then behave ${featurePath} --format json 2>&1; else pytest -v 2>&1; fi`;
    case "ruby":
      return `bundle exec cucumber ${featurePath} --format json 2>&1`;
    case "java":
      return `mvn test -Dcucumber.features=${featurePath} 2>&1`;
    case "go":
      return `godog run ${featurePath} --format json 2>&1`;
    case "rust":
      return `cargo test --test cucumber -- ${featurePath} 2>&1`;
    case "php":
      return `vendor/bin/behat ${featurePath} --format json 2>&1`;
    case "csharp":
      return `dotnet test --filter "FeaturePath~${featurePath}" --logger "console;verbosity=detailed" 2>&1`;
    case "kotlin":
      return `gradle test -Dcucumber.features=${featurePath} 2>&1`;
    case "c":
    case "cpp":
      return (
        `if [ -d build ]; then ` +
        `  ctest --test-dir build --output-on-failure -R bdd 2>&1; ` +
        `else cmake -B build && cmake --build build && ctest --test-dir build --output-on-failure -R bdd 2>&1; fi`
      );
    case "swift":
      return `swift test --filter BDD 2>&1`;
    default:
      return null;
  }
}

/**
 * Parse scenario names from Gherkin content.
 */
function parseScenarios(gherkinContent: string): string[] {
  const scenarios: string[] = [];
  const lines = gherkinContent.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    const match = trimmed.match(/^(?:Scenario|Scenario Outline):\s*(.+)$/);
    if (match) {
      scenarios.push(match[1]);
    }
  }
  // If no scenarios found, use a generic name
  if (scenarios.length === 0) {
    scenarios.push("(unnamed scenario)");
  }
  return scenarios;
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
    case "ruby":
      return (
        "if [ -f Gemfile ] && bundle list 2>/dev/null | grep -q rspec; then " +
        "  bundle exec rspec --format json 2>&1; " +
        "elif [ -d test ]; then " +
        "  ruby -Itest -e 'Dir.glob(\"test/**/*_test.rb\").each { |f| require \"./#{f}\" }' 2>&1; " +
        "else " +
        "  echo 'No test runner found' && exit 0; fi"
      );
    case "php":
      return (
        "if [ -f vendor/bin/phpunit ]; then " +
        "  vendor/bin/phpunit --log-junit /tmp/test-result.xml 2>&1; " +
        "elif command -v phpunit &>/dev/null; then " +
        "  phpunit --log-junit /tmp/test-result.xml 2>&1; " +
        "else echo 'PHPUnit not found' && exit 0; fi"
      );
    case "csharp":
      return "dotnet test --logger 'console;verbosity=detailed' 2>&1";
    case "c":
    case "cpp":
      return (
        "if [ -d build ]; then " +
        "  ctest --test-dir build --output-on-failure 2>&1; " +
        "elif [ -f Makefile ]; then " +
        "  make test 2>&1; " +
        "else echo 'No test runner found' && exit 0; fi"
      );
    case "swift":
      return "swift test 2>&1";
    case "kotlin":
      return (
        "if [ -f build.gradle.kts ] || [ -f build.gradle ]; then gradle test 2>&1; " +
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
    case "ruby":
      return parseRspec(output);
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

/** Parse RSpec JSON output. */
function parseRspec(output: string): TestSummary | null {
  const parsed = parseJsonSafe<RspecOutput>(output);
  if (!parsed?.summary) return null;

  return {
    total: parsed.summary.example_count ?? 0,
    passed: (parsed.summary.example_count ?? 0) - (parsed.summary.failure_count ?? 0) - (parsed.summary.pending_count ?? 0),
    failed: parsed.summary.failure_count ?? 0,
    skipped: parsed.summary.pending_count ?? 0,
    duration: parsed.summary.duration,
  };
}

interface RspecOutput {
  summary?: {
    example_count?: number;
    failure_count?: number;
    pending_count?: number;
    duration?: number;
  };
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "\n... (truncated)";
}
