/**
 * Shared test utilities for gate unit tests.
 */
import { vi } from "vitest";
import type { VMHandle } from "../vm/firecracker";
import type { DiffContext } from "../lib/diffContext";
import type { GateResult } from "../queue/jobQueue";

/** Default exec result used by mockVM. */
const DEFAULT_EXEC_RESULT = { stdout: "", stderr: "", exitCode: 0 };

/**
 * Create a mock VMHandle with a configurable exec implementation.
 */
export function mockVM(
  execImpl?: (command: string, timeoutMs?: number) => Promise<{ stdout: string; stderr: string; exitCode: number }>,
): VMHandle {
  return {
    vmId: "test-vm",
    jobId: "test-job",
    guestIp: "192.168.0.2",
    exec: vi.fn(execImpl ?? (async () => ({ ...DEFAULT_EXEC_RESULT }))),
    writeFile: vi.fn(async () => {}),
  };
}

/**
 * Create a mock DiffContext with sensible defaults.
 */
export function mockDiffContext(overrides: Partial<DiffContext> = {}): DiffContext {
  return {
    baseCommitSha: "base1234",
    agentCommitSha: "agent5678",
    changedFiles: ["src/index.ts"],
    changedLineRanges: new Map([["src/index.ts", [[1, 50]]]]),
    ...overrides,
  };
}

/** Assert that a gate result has status "pass". */
export function expectGatePass(result: GateResult) {
  if (result.status !== "pass") {
    throw new Error(
      `Expected gate "${result.gate}" to pass, but got status "${result.status}": ${result.summary}`,
    );
  }
}

/** Assert that a gate result has status "fail". */
export function expectGateFail(result: GateResult) {
  if (result.status !== "fail") {
    throw new Error(
      `Expected gate "${result.gate}" to fail, but got status "${result.status}": ${result.summary}`,
    );
  }
}

/** Assert that a gate result has status "skipped". */
export function expectGateSkipped(result: GateResult) {
  if (result.status !== "skipped") {
    throw new Error(
      `Expected gate "${result.gate}" to be skipped, but got status "${result.status}": ${result.summary}`,
    );
  }
}
