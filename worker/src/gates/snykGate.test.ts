import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockVM, expectGatePass, expectGateFail, expectGateSkipped } from "./__test-helpers__";

vi.mock("../index", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { runSnykGate } from "./snykGate";

describe("runSnykGate", () => {
  const originalEnv = process.env.SNYK_TOKEN;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.SNYK_TOKEN = originalEnv;
    } else {
      delete process.env.SNYK_TOKEN;
    }
  });

  it("missing SNYK_TOKEN -> 'skipped'", async () => {
    delete process.env.SNYK_TOKEN;
    const vm = mockVM();
    const result = await runSnykGate(vm, "typescript", 60_000, null);
    expectGateSkipped(result);
    expect(result.summary).toContain("SNYK_TOKEN missing");
  });

  it("no vulnerabilities -> 'pass'", async () => {
    process.env.SNYK_TOKEN = "test-token";
    const vm = mockVM(async () => ({
      stdout: JSON.stringify({ vulnerabilities: [] }),
      stderr: "",
      exitCode: 0,
    }));
    const result = await runSnykGate(vm, "typescript", 60_000, null);
    expectGatePass(result);
  });

  it("HIGH vulnerability -> 'fail'", async () => {
    process.env.SNYK_TOKEN = "test-token";
    const snykOutput = JSON.stringify({
      vulnerabilities: [
        { id: "SNYK-001", severity: "high", title: "Prototype Pollution", packageName: "lodash" },
      ],
    });
    const vm = mockVM(async () => ({
      stdout: snykOutput,
      stderr: "",
      exitCode: 1,
    }));
    const result = await runSnykGate(vm, "typescript", 60_000, null);
    expectGateFail(result);
    expect(result.summary).toContain("1 high");
  });

  it("CRITICAL vulnerability -> 'fail' with critical count", async () => {
    process.env.SNYK_TOKEN = "test-token";
    const snykOutput = JSON.stringify({
      vulnerabilities: [
        { id: "SNYK-002", severity: "critical", title: "RCE", packageName: "unsafe-pkg" },
      ],
    });
    const vm = mockVM(async () => ({
      stdout: snykOutput,
      stderr: "",
      exitCode: 1,
    }));
    const result = await runSnykGate(vm, "typescript", 60_000, null);
    expectGateFail(result);
    expect(result.summary).toContain("1 critical");
  });
});
