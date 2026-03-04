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
  const state: BddExecutionState = {
    allSteps: [],
    stepCounter: 0,
    overallFailed: false,
  };

  // SECURITY: Inject step definitions into root-owned directory in the VM.
  // The agent user cannot read /run/bdd_steps/ directly.
  const stepDefsDir = "/run/bdd_steps";
  await execOrThrow(
    vm,
    `mkdir -p ${shellQuote(stepDefsDir)} && chmod 700 ${shellQuote(stepDefsDir)}`,
    5_000,
    "root",
  );

  let publicStepDefPaths: string[];
  let hiddenStepDefPaths: string[];
  try {
    publicStepDefPaths = await injectStepDefinitions({
      vm,
      stepDefsDir,
      stepDefsJson: stepDefinitionsPublic,
      label: "public",
    });
    hiddenStepDefPaths = await injectStepDefinitions({
      vm,
      stepDefsDir,
      stepDefsJson: stepDefinitionsHidden,
      label: "hidden",
    });
  } catch (err) {
    logger.error("Failed to inject BDD step definitions", { error: String(err) });
    return {
      gate: "test",
      status: "error",
      durationMs: Date.now() - start,
      summary: `Failed to inject BDD step definitions: ${err instanceof Error ? err.message : String(err)}`,
      details: {
        exitCode: 1,
      },
    };
  }

  const publicSuites = testSuites.filter((testSuite) => testSuite.visibility === "public");
  const hiddenSuites = testSuites.filter((testSuite) => testSuite.visibility === "hidden");
  const bddExecUser = (publicStepDefPaths.length > 0 || hiddenStepDefPaths.length > 0)
    ? "root"
    : undefined;

  // Run public suites first, then hidden
  for (const group of suiteGroups(publicSuites, hiddenSuites)) {
    for (const suite of group.suites) {
      await executeBddSuite({
        vm,
        language,
        timeoutMs,
        suite,
        visibility: group.visibility,
        stepDefPaths: group.visibility === "public" ? publicStepDefPaths : hiddenStepDefPaths,
        bddExecUser,
        state,
      });
    }
  }

  // SECURITY: Delete step definition files immediately after test execution
  await vm.exec(`rm -rf ${shellQuote(stepDefsDir)}`, 5_000, "root").catch(() => {});

  const durationMs = Date.now() - start;
  const passed = state.allSteps.filter((step) => step.status === "pass").length;
  const failed = state.allSteps.filter((step) => step.status === "fail").length;

  return {
    gate: "test",
    status: state.overallFailed ? "fail" : "pass",
    durationMs,
    summary: state.overallFailed
      ? `Tests failed: ${failed} of ${state.allSteps.length} scenario(s) failed`
      : `All tests passed (${passed} passed, ${state.allSteps.length} total)`,
    details: {
      total: state.allSteps.length,
      passed,
      failed,
      exitCode: state.overallFailed ? 1 : 0,
    },
    steps: state.allSteps,
  };
}

interface BddExecutionState {
  allSteps: StepResult[];
  stepCounter: number;
  overallFailed: boolean;
}

interface StepDefinitionFile {
  path: string;
  content: string;
}

function suiteGroups(publicSuites: TestSuiteInput[], hiddenSuites: TestSuiteInput[]) {
  return [
    { suites: publicSuites, visibility: "public" as const },
    { suites: hiddenSuites, visibility: "hidden" as const },
  ];
}

function parseStepDefinitionFiles(stepDefsJson?: string): StepDefinitionFile[] {
  if (!stepDefsJson) return [];
  const files = JSON.parse(stepDefsJson);
  if (!Array.isArray(files)) return [];

  const parsedFiles: StepDefinitionFile[] = [];
  for (const file of files) {
    if (typeof file?.path === "string" && typeof file?.content === "string") {
      parsedFiles.push({ path: file.path, content: file.content });
    }
  }
  return parsedFiles;
}

async function injectStepDefinitions(args: {
  vm: VMHandle;
  stepDefsDir: string;
  stepDefsJson?: string;
  label: string;
}): Promise<string[]> {
  const injectedPaths: string[] = [];
  for (const file of parseStepDefinitionFiles(args.stepDefsJson)) {
    const targetPath = `${args.stepDefsDir}/${args.label}_${file.path.replaceAll("/", "_")}`;
    const normalizedContent = normalizeStepDefinitionContent(file.content);

    if (args.vm.execWithStdin) {
      const result = await args.vm.execWithStdin(
        `cat > ${shellQuote(targetPath)} && chmod 0400 ${shellQuote(targetPath)} && chown root:root ${shellQuote(targetPath)}`,
        normalizedContent,
        30_000,
        "root",
      );
      if (result.exitCode !== 0) {
        const failureReason = result.stderr || result.stdout || `exit ${result.exitCode}`;
        throw new Error(`failed writing step defs to ${targetPath}: ${failureReason}`);
      }
    } else {
      const b64 = Buffer.from(normalizedContent, "utf-8").toString("base64");
      await execOrThrow(
        args.vm,
        `echo ${shellQuote(b64)} | base64 -d > ${shellQuote(targetPath)} && chmod 0400 ${shellQuote(targetPath)} && chown root:root ${shellQuote(targetPath)}`,
        30_000,
        "root",
      );
    }

    injectedPaths.push(targetPath);
  }
  return injectedPaths;
}

function appendSuiteStepResults(args: {
  state: BddExecutionState;
  scenarios: string[];
  featureName: string;
  visibility: "public" | "hidden";
  status: "pass" | "fail";
  output?: string;
}): void {
  if (args.status === "fail") {
    args.state.overallFailed = true;
  }
  for (const scenario of args.scenarios) {
    args.state.allSteps.push({
      scenarioName: scenario,
      featureName: args.featureName,
      status: args.status,
      executionTimeMs: 0,
      output: args.output,
      stepNumber: args.state.stepCounter++,
      visibility: args.visibility,
    });
  }
}

async function executeBddSuite(args: {
  vm: VMHandle;
  language: string;
  timeoutMs: number;
  suite: TestSuiteInput;
  visibility: "public" | "hidden";
  stepDefPaths: string[];
  bddExecUser?: string;
  state: BddExecutionState;
}): Promise<void> {
  const featurePath = `/tmp/bdd_${args.visibility}_${args.state.stepCounter}.feature`;
  const b64 = Buffer.from(args.suite.gherkinContent).toString("base64");
  await args.vm.exec(`echo '${b64}' | base64 -d > ${featurePath}`, 5_000);

  const command = getBddTestCommand(args.language, featurePath, args.stepDefPaths);
  if (!command) return;

  const result = await args.vm.exec(
    `cd /workspace && ${command} 2>&1`,
    args.timeoutMs,
    args.bddExecUser,
  );

  const scenarios = parseScenarios(args.suite.gherkinContent);
  const featureName = args.suite.title;
  if (result.exitCode === 0) {
    appendSuiteStepResults({
      state: args.state,
      scenarios,
      featureName,
      visibility: args.visibility,
      status: "pass",
    });
    return;
  }

  appendSuiteStepResults({
    state: args.state,
    scenarios,
    featureName,
    visibility: args.visibility,
    status: "fail",
    output: truncate(result.stdout, 5_000),
  });
}

async function execOrThrow(
  vm: VMHandle,
  command: string,
  timeoutMs: number,
  user?: string,
): Promise<void> {
  const result = await vm.exec(command, timeoutMs, user);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || `command failed with exit code ${result.exitCode}`);
  }
}

function normalizeStepDefinitionContent(content: string): string {
  // Some payloads arrive double-escaped ("\\n", "\\\""), which breaks runtime parsing.
  if (content.includes("\n")) {
    return content;
  }
  if (!content.includes("\\n") && !content.includes("\\r") && !content.includes("\\t")) {
    return content;
  }
  const normalized = content
    .replace(/\\\\/g, "\\")
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, "\"");

  // Step definitions may call require("@cucumber/cucumber") from /run paths.
  // Resolve via the cucumber runner entrypoint so npx-installed modules are found.
  return normalized.replace(
    /require\((['"])@cucumber\/cucumber\1\)/g,
    "require.main.require('@cucumber/cucumber')",
  );
}

/**
 * Get the BDD test runner command for a specific feature file.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function getBddTestCommand(
  language: string,
  featurePath: string,
  stepDefPaths: string[],
): string | null {
  switch (language.toLowerCase()) {
    case "typescript":
    case "javascript":
      {
      const requireArgs = stepDefPaths
        .map((path) => `--require ${shellQuote(path)}`)
        .join(" ");
      return (
        `if npx --yes @cucumber/cucumber cucumber-js --version &>/dev/null; then ` +
        `  npx --yes @cucumber/cucumber cucumber-js ${shellQuote(featurePath)} ${requireArgs} --format json 2>&1; ` +
        `elif npx jest --version &>/dev/null; then ` +
        `  npx jest --testPathPattern='.*' --json 2>&1; ` +
        `else npm test 2>&1; fi`
      );
      }
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
    if (!event?.Action) continue;

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
