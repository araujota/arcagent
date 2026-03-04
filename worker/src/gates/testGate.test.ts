import { describe, it, expect, vi } from "vitest";
import { mockVM, expectGatePass, expectGateFail, expectGateSkipped } from "./__test-helpers__";

vi.mock("../index", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { runTestGate } from "./testGate";
import type { TestSuiteInput } from "../queue/jobQueue";
import type { VMHandle } from "../vm/firecracker";

describe("runTestGate", () => {
  it("TypeScript: detects vitest/jest, exit 0 -> 'pass'", async () => {
    const jestOutput = JSON.stringify({
      numTotalTests: 10,
      numPassedTests: 10,
      numFailedTests: 0,
      numPendingTests: 0,
      numTotalTestSuites: 3,
      testResults: [],
    });
    const vm = mockVM(async () => ({ stdout: jestOutput, stderr: "", exitCode: 0 }));
    const result = await runTestGate(vm, "typescript", 60_000, null);
    expectGatePass(result);
    expect(result.summary).toContain("10 passed");
  });

  it("Failure: parses JSON for failure count", async () => {
    const jestOutput = JSON.stringify({
      numTotalTests: 10,
      numPassedTests: 8,
      numFailedTests: 2,
      numPendingTests: 0,
      numTotalTestSuites: 3,
      testResults: [{
        assertionResults: [{
          status: "failed",
          fullName: "should work",
          failureMessages: ["Expected true, got false"],
        }],
      }],
    });
    const vm = mockVM(async () => ({ stdout: jestOutput, stderr: "", exitCode: 1 }));
    const result = await runTestGate(vm, "typescript", 60_000, null);
    expectGateFail(result);
    expect(result.summary).toContain("2 of 10");
  });

  it("Unsupported language -> 'skipped'", async () => {
    const vm = mockVM();
    const result = await runTestGate(vm, "brainfuck", 60_000, null);
    expectGateSkipped(result);
    expect(result.status).toBe("skipped");
  });

  it("BDD path: writes feature files and runs them", async () => {
    const execCalls: string[] = [];
    const vm = mockVM(async (cmd: string) => {
      execCalls.push(cmd);
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const suites: TestSuiteInput[] = [{
      id: "suite-1",
      title: "User Login",
      gherkinContent: "Feature: Login\n  Scenario: Valid login\n    Given a user",
      visibility: "public",
    }];
    const result = await runTestGate(vm, "typescript", 60_000, null, suites);
    expectGatePass(result);
    // Should have written the feature file via base64
    const writeCall = execCalls.find((c) => c.includes("base64 -d"));
    expect(writeCall).toBeDefined();
    expect(result.steps).toBeDefined();
    expect(result.steps!.length).toBeGreaterThan(0);
    expect(result.steps![0]!.visibility).toBe("public");
  });

  it("BDD: passing and failing scenarios produce correct StepResult", async () => {
    let callIdx = 0;
    const vm = mockVM(async (cmd: string) => {
      // First suite call: the mkdir/setup commands pass
      // The actual test run: alternate pass/fail
      if (cmd.includes("cucumber") || cmd.includes("npm test") || cmd.includes("jest")) {
        callIdx++;
        if (callIdx <= 1) {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        return { stdout: "Test failed!", stderr: "", exitCode: 1 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const suites: TestSuiteInput[] = [
      {
        id: "s1",
        title: "Feature A",
        gherkinContent: "Feature: A\n  Scenario: Pass scenario\n    Given something",
        visibility: "public",
      },
      {
        id: "s2",
        title: "Feature B",
        gherkinContent: "Feature: B\n  Scenario: Fail scenario\n    Given something else",
        visibility: "hidden",
      },
    ];
    const result = await runTestGate(vm, "typescript", 60_000, null, suites);
    expect(result.steps).toBeDefined();
    const publicSteps = result.steps!.filter((s) => s.visibility === "public");
    const hiddenSteps = result.steps!.filter((s) => s.visibility === "hidden");
    expect(publicSteps.length).toBeGreaterThan(0);
    expect(hiddenSteps.length).toBeGreaterThan(0);
  });

  it("BDD: cleans up step definitions after execution", async () => {
    const execCalls: string[] = [];
    const vm = mockVM(async (cmd: string) => {
      execCalls.push(cmd);
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const suites: TestSuiteInput[] = [{
      id: "s1",
      title: "Test",
      gherkinContent: "Feature: X\n  Scenario: Y\n    Given Z",
      visibility: "public",
    }];
    await runTestGate(vm, "typescript", 60_000, null, suites, '[]', undefined);
    // Should have an rm -rf call for step definitions cleanup
    const cleanupCall = execCalls.find((c) => c.includes("rm -rf") && c.includes("bdd_steps"));
    expect(cleanupCall).toBeDefined();
  });

  it("BDD: runs cucumber as root when injected step definitions are present", async () => {
    const vm = mockVM(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const suites: TestSuiteInput[] = [{
      id: "s1",
      title: "Test",
      gherkinContent: "Feature: X\n  Scenario: Y\n    Given Z",
      visibility: "public",
    }];
    await runTestGate(
      vm,
      "typescript",
      60_000,
      null,
      suites,
      JSON.stringify([{ path: "steps/public.js", content: "module.exports = {};" }]),
      undefined,
    );

    const calls = (vm.exec as ReturnType<typeof vi.fn>).mock.calls;
    const cucumberCall = calls.find((c) => String(c[0]).includes("cucumber-js"));
    expect(cucumberCall).toBeDefined();
    expect(cucumberCall?.[2]).toBe("root");
  });

  it("BDD: decodes double-escaped step definition content before injection", async () => {
    const exec = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const execWithStdin = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const vm: VMHandle = {
      vmId: "vm-test",
      jobId: "job-test",
      guestIp: "10.0.0.2",
      exec,
      execWithStdin,
    };
    const suites: TestSuiteInput[] = [{
      id: "s1",
      title: "Test",
      gherkinContent: "Feature: X\n  Scenario: Y\n    Given Z",
      visibility: "public",
    }];

    await runTestGate(
      vm,
      "typescript",
      60_000,
      null,
      suites,
      JSON.stringify([{ path: "steps/public.js", content: "const { Given } = require('@cucumber/cucumber');\\\\nline2" }]),
      undefined,
    );

    expect(execWithStdin).toHaveBeenCalled();
    const stdinPayload = execWithStdin.mock.calls[0]?.[1] as string;
    expect(stdinPayload).toContain("require.main.require('@cucumber/cucumber')");
    expect(stdinPayload).toContain("\nline2");
  });

  it("Python: uses pytest or unittest", async () => {
    const vm = mockVM(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    await runTestGate(vm, "python", 60_000, null);
    const cmd = (vm.exec as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(cmd).toContain("pytest");
  });

  it("Go: uses go test", async () => {
    const vm = mockVM(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    await runTestGate(vm, "go", 60_000, null);
    const cmd = (vm.exec as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(cmd).toContain("go test");
  });
});
