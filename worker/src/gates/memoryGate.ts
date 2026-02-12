import { VMHandle } from "../vm/firecracker";
import { GateResult } from "../queue/jobQueue";
import { DiffContext } from "../lib/diffContext";
import { parseJsonSafe } from "../lib/resultParser";
import { logger } from "../index";

/**
 * Memory safety gate — runs Valgrind or AddressSanitizer for C/C++ projects.
 *
 * Auto-skips for all languages other than `c` and `cpp`.
 * Non-fail-fast: memory issues are reported but don't abort the pipeline.
 */
export async function runMemoryGate(
  vm: VMHandle,
  language: string,
  timeoutMs: number,
  _diff: DiffContext | null,
): Promise<GateResult> {
  const start = Date.now();

  // Only applicable to C/C++
  if (language !== "c" && language !== "cpp") {
    return {
      gate: "memory",
      status: "skipped",
      durationMs: Date.now() - start,
      summary: `Memory safety gate only applies to C/C++ (language: ${language})`,
    };
  }

  // Try Valgrind first, fall back to AddressSanitizer
  const hasValgrind = await checkToolAvailable(vm, "valgrind");

  if (hasValgrind) {
    return runValgrind(vm, timeoutMs, start);
  }

  logger.info("Valgrind not available, falling back to AddressSanitizer");
  return runAddressSanitizer(vm, language, timeoutMs, start);
}

// ---------------------------------------------------------------------------
// Valgrind
// ---------------------------------------------------------------------------

async function runValgrind(
  vm: VMHandle,
  timeoutMs: number,
  start: number,
): Promise<GateResult> {
  const result = await vm.exec(
    "cd /workspace && " +
    "valgrind --leak-check=full --error-exitcode=42 " +
    "--xml=yes --xml-file=/tmp/valgrind.xml " +
    "ctest --test-dir build --output-on-failure 2>&1",
    timeoutMs,
  );

  const durationMs = Date.now() - start;

  // Read XML output for structured errors
  const xmlResult = await vm.exec("cat /tmp/valgrind.xml 2>/dev/null", 5_000);
  const errors = parseValgrindXml(xmlResult.stdout);

  if (result.exitCode === 42) {
    return {
      gate: "memory",
      status: "fail",
      durationMs,
      summary: `Valgrind detected ${errors.length} memory error(s)`,
      details: {
        tool: "valgrind",
        exitCode: result.exitCode,
        errorCount: errors.length,
        errors: errors.slice(0, 20),
        rawOutput: truncate(result.stdout, 5_000),
      },
    };
  }

  if (result.exitCode !== 0) {
    return {
      gate: "memory",
      status: "error",
      durationMs,
      summary: `Valgrind exited with code ${result.exitCode} (test execution may have failed)`,
      details: {
        tool: "valgrind",
        exitCode: result.exitCode,
        rawOutput: truncate(result.stdout, 5_000),
      },
    };
  }

  return {
    gate: "memory",
    status: "pass",
    durationMs,
    summary: "Valgrind found no memory errors",
    details: { tool: "valgrind" },
  };
}

// ---------------------------------------------------------------------------
// AddressSanitizer
// ---------------------------------------------------------------------------

async function runAddressSanitizer(
  vm: VMHandle,
  language: string,
  timeoutMs: number,
  start: number,
): Promise<GateResult> {
  const buildFlags = language === "cpp"
    ? 'CXXFLAGS="-fsanitize=address -fno-omit-frame-pointer -g"'
    : 'CFLAGS="-fsanitize=address -fno-omit-frame-pointer -g"';

  const result = await vm.exec(
    `cd /workspace && ${buildFlags} cmake -B build-asan 2>&1 && ` +
    "cmake --build build-asan 2>&1 && " +
    "ctest --test-dir build-asan --output-on-failure 2>&1",
    timeoutMs,
  );

  const durationMs = Date.now() - start;

  // ASan reports errors to stderr and typically causes a non-zero exit
  const hasAsanError =
    result.stdout.includes("ERROR: AddressSanitizer") ||
    result.stderr.includes("ERROR: AddressSanitizer");

  if (hasAsanError) {
    const errorLines = (result.stdout + "\n" + result.stderr)
      .split("\n")
      .filter((l) => l.includes("ERROR: AddressSanitizer") || l.includes("SUMMARY:"));

    return {
      gate: "memory",
      status: "fail",
      durationMs,
      summary: `AddressSanitizer detected memory error(s)`,
      details: {
        tool: "asan",
        exitCode: result.exitCode,
        errors: errorLines.slice(0, 20),
        rawOutput: truncate(result.stdout, 5_000),
      },
    };
  }

  if (result.exitCode !== 0) {
    return {
      gate: "memory",
      status: "error",
      durationMs,
      summary: `ASan build/test failed with exit code ${result.exitCode}`,
      details: {
        tool: "asan",
        exitCode: result.exitCode,
        rawOutput: truncate(result.stdout, 5_000),
      },
    };
  }

  return {
    gate: "memory",
    status: "pass",
    durationMs,
    summary: "AddressSanitizer found no memory errors",
    details: { tool: "asan" },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function checkToolAvailable(vm: VMHandle, tool: string): Promise<boolean> {
  const result = await vm.exec(`command -v ${tool} 2>/dev/null`, 5_000);
  return result.exitCode === 0;
}

interface ValgrindError {
  kind: string;
  what: string;
}

function parseValgrindXml(xml: string): ValgrindError[] {
  const errors: ValgrindError[] = [];

  // Simple regex-based extraction from Valgrind XML
  const errorBlocks = xml.match(/<error>[\s\S]*?<\/error>/g) ?? [];

  for (const block of errorBlocks) {
    const kindMatch = block.match(/<kind>([^<]+)<\/kind>/);
    const whatMatch = block.match(/<what>([^<]+)<\/what>/) ??
                      block.match(/<xwhat><text>([^<]+)<\/text>/);

    errors.push({
      kind: kindMatch?.[1] ?? "unknown",
      what: whatMatch?.[1] ?? "unknown error",
    });
  }

  return errors;
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "\n... (truncated)";
}
