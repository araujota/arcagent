import { describe, it, expect, vi, afterEach } from "vitest";
import { mockVM, expectGatePass, expectGateFail, expectGateSkipped } from "./__test-helpers__";

vi.mock("../index", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { runSonarQubeGate } from "./sonarqubeGate";

describe("runSonarQubeGate", () => {
  const origUrl = process.env.SONARQUBE_URL;
  const origToken = process.env.SONARQUBE_TOKEN;

  afterEach(() => {
    if (origUrl !== undefined) process.env.SONARQUBE_URL = origUrl;
    else delete process.env.SONARQUBE_URL;
    if (origToken !== undefined) process.env.SONARQUBE_TOKEN = origToken;
    else delete process.env.SONARQUBE_TOKEN;
  });

  it("missing config -> 'skipped'", async () => {
    delete process.env.SONARQUBE_URL;
    delete process.env.SONARQUBE_TOKEN;
    const vm = mockVM();
    const result = await runSonarQubeGate(vm, "typescript", 60_000, null);
    expectGateSkipped(result);
    expect(result.summary).toContain("not configured");
  });

  it("quality gate OK -> 'pass'", async () => {
    process.env.SONARQUBE_URL = "https://sonar.example.com";
    process.env.SONARQUBE_TOKEN = "test-token";
    const vm = mockVM(async (cmd: string) => {
      if (cmd.includes("curl")) {
        return {
          stdout: JSON.stringify({
            projectStatus: { status: "OK", conditions: [] },
          }),
          stderr: "",
          exitCode: 0,
        };
      }
      // Scanner runs
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const result = await runSonarQubeGate(vm, "typescript", 60_000, null);
    expectGatePass(result);
    expect(result.summary).toContain("passed");
  });

  it("quality gate ERROR -> 'fail'", async () => {
    process.env.SONARQUBE_URL = "https://sonar.example.com";
    process.env.SONARQUBE_TOKEN = "test-token";
    const vm = mockVM(async (cmd: string) => {
      if (cmd.includes("curl")) {
        return {
          stdout: JSON.stringify({
            projectStatus: {
              status: "ERROR",
              conditions: [{
                status: "ERROR",
                metricKey: "new_reliability_rating",
                comparator: "GT",
                errorThreshold: "1",
                actualValue: "4",
              }],
            },
          }),
          stderr: "",
          exitCode: 0,
        };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const result = await runSonarQubeGate(vm, "typescript", 60_000, null);
    expectGateFail(result);
    expect(result.summary).toContain("failed");
  });

  it("scanner failure -> 'error'", async () => {
    process.env.SONARQUBE_URL = "https://sonar.example.com";
    process.env.SONARQUBE_TOKEN = "test-token";
    const vm = mockVM(async () => ({
      stdout: "",
      stderr: "Scanner crashed",
      exitCode: 2,
    }));
    const result = await runSonarQubeGate(vm, "typescript", 60_000, null);
    expect(result.status).toBe("error");
    expect(result.summary).toContain("exit code 2");
  });
});
