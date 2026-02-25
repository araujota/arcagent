import { afterEach, describe, expect, it, vi } from "vitest";
import { runSnykGate } from "./snykGate";

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
  return { exec } as any;
}

describe("runSnykGate", () => {
  afterEach(() => {
    delete process.env.SNYK_TOKEN;
  });

  it("skips when SNYK_TOKEN is missing", async () => {
    const vm = makeVmExec([]);
    const result = await runSnykGate(vm, "typescript", 60_000, null);
    expect(result.status).toBe("skipped");
    expect(result.summary).toContain("SNYK_TOKEN missing");
  });

  it("returns error when snyk CLI is unavailable", async () => {
    process.env.SNYK_TOKEN = "token";
    const vm = makeVmExec([{ exitCode: 1 }]);
    const result = await runSnykGate(vm, "typescript", 60_000, null);
    expect(result.status).toBe("error");
    expect(result.summary).toContain("CLI not available");
  });

  it("skips unsupported languages", async () => {
    process.env.SNYK_TOKEN = "token";
    const vm = makeVmExec([]);
    const result = await runSnykGate(vm, "python", 60_000, null);
    expect(result.status).toBe("skipped");
    expect(result.summary).toContain("not enabled for language");
  });

  it("fails when high severity vulnerabilities are found", async () => {
    process.env.SNYK_TOKEN = "token";
    const vm = makeVmExec([
      { exitCode: 0 },
      {
        exitCode: 1,
        stdout: JSON.stringify({
          vulnerabilities: [{ severity: "high", id: "x" }],
        }),
      },
      {
        exitCode: 0,
        stdout: JSON.stringify({ runs: [{ results: [] }] }),
      },
    ]);

    const result = await runSnykGate(vm, "typescript", 60_000, null);
    expect(result.status).toBe("fail");
    expect(result.summary).toContain("high severity");
  });

  it("returns error instead of false pass when scanner exits without JSON", async () => {
    process.env.SNYK_TOKEN = "token";
    const vm = makeVmExec([
      { exitCode: 0 },
      { exitCode: 2, stdout: "" },
      { exitCode: 2, stdout: "" },
    ]);

    const result = await runSnykGate(vm, "typescript", 60_000, null);
    expect(result.status).toBe("error");
    expect(result.summary).toContain("scanner execution error");
  });
});
