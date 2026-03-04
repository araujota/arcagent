import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../index", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

let runSonarQubeGate!: typeof import("./sonarqubeGate").runSonarQubeGate;

function makeVmExec(responses: Array<{ stdout?: string; stderr?: string; exitCode: number }>) {
  const exec = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("No VM response queued");
    return {
      stdout: next.stdout ?? "",
      stderr: next.stderr ?? "",
      exitCode: next.exitCode,
    };
  });
  return { exec, jobId: "job-123" } as any;
}

describe("runSonarQubeGate", () => {
  beforeAll(async () => {
    ({ runSonarQubeGate } = await import("./sonarqubeGate"));
  });

  afterEach(() => {
    process.env.SONARQUBE_URL = "";
    process.env.SONARQUBE_TOKEN = "";
    process.env.FC_HARDEN_EGRESS = "";
    process.env.NODE_ENV = "";
  });

  it("skips when SonarQube env vars are missing", async () => {
    const vm = makeVmExec([]);
    const result = await runSonarQubeGate(vm, "typescript", 60_000, null);
    expect(result.status).toBe("skipped");
  });

  it("returns error when hardened egress is enabled but URL is not HTTPS", async () => {
    process.env.SONARQUBE_URL = "http://sonarqube:9000";
    process.env.SONARQUBE_TOKEN = "token";
    process.env.FC_HARDEN_EGRESS = "true";

    const vm = makeVmExec([]);
    const result = await runSonarQubeGate(vm, "typescript", 60_000, null);
    expect(result.status).toBe("error");
    expect(result.summary).toContain("https://");
  });

  it("returns error when scanner command fails", async () => {
    process.env.SONARQUBE_URL = "https://sonar.example.com";
    process.env.SONARQUBE_TOKEN = "token";

    const vm = makeVmExec([
      { exitCode: 0 },
      { exitCode: 1, stderr: "scanner failed" },
    ]);

    const result = await runSonarQubeGate(vm, "typescript", 60_000, null);
    expect(result.status).toBe("error");
    expect(result.summary).toContain("scanner failed");
  });

  it("fails when quality gate is ERROR", async () => {
    process.env.SONARQUBE_URL = "https://sonar.example.com";
    process.env.SONARQUBE_TOKEN = "token";

    const vm = makeVmExec([
      { exitCode: 0 },
      { exitCode: 0, stdout: "scanner ok" },
      {
        exitCode: 0,
        stdout: JSON.stringify({
          projectStatus: {
            status: "ERROR",
            conditions: [
              {
                status: "ERROR",
                metricKey: "bugs",
                actualValue: "2",
                errorThreshold: "0",
                comparator: "GT",
              },
            ],
          },
        }),
      },
      {
        exitCode: 0,
        stdout: JSON.stringify({
          component: { measures: [{ metric: "new_bugs", value: "2" }] },
        }),
      },
      {
        exitCode: 0,
        stdout: JSON.stringify({
          issues: [
            {
              rule: "typescript:S123",
              severity: "CRITICAL",
              component: "src/service.ts",
              line: 10,
              type: "BUG",
              message: "Potential bug",
            },
          ],
        }),
      },
    ]);

    const result = await runSonarQubeGate(vm, "typescript", 60_000, null);
    expect(result.status).toBe("fail");
    expect(result.summary).toContain("quality gate failed");
  });

  it("returns error when quality gate polling times out", async () => {
    process.env.SONARQUBE_URL = "https://sonar.example.com";
    process.env.SONARQUBE_TOKEN = "token";

    const timeoutMs = 6_000;
    const vm = makeVmExec([
      { exitCode: 0 },
      { exitCode: 0, stdout: "scanner ok" },
      ...Array.from({ length: Math.min(Math.floor(timeoutMs / 5_000), 24) }, () => ({
        exitCode: 0,
        stdout: JSON.stringify({ projectStatus: { status: "IN_PROGRESS", conditions: [] } }),
      })),
      { exitCode: 0, stdout: JSON.stringify({ component: { measures: [] } }) },
      { exitCode: 0, stdout: JSON.stringify({ issues: [] }) },
    ]);

    const result = await runSonarQubeGate(vm, "typescript", timeoutMs, null);
    expect(result.status).toBe("error");
    expect(result.summary).toContain("polling timed out");
    expect((result.details as any)?.reasonCode).toBe("quality_gate_timeout");
  });
});
