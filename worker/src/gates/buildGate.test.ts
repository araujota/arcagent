import { describe, it, expect, vi } from "vitest";
import { mockVM, mockDiffContext, expectGatePass, expectGateFail, expectGateSkipped } from "./__test-helpers__";

vi.mock("../index", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { runBuildGate } from "./buildGate";

describe("runBuildGate", () => {
  it("TypeScript: exit 0 -> status 'pass', summary 'Build succeeded'", async () => {
    const vm = mockVM(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const result = await runBuildGate(vm, "typescript", 60_000, null);
    expectGatePass(result);
    expect(result.summary).toBe("Build succeeded");
  });

  it("TypeScript: non-zero exit -> status 'fail', includes exitCode and truncated output", async () => {
    const vm = mockVM(async () => ({
      stdout: "Error: Cannot find module 'foo'",
      stderr: "npm ERR! build failed",
      exitCode: 1,
    }));
    const result = await runBuildGate(vm, "typescript", 60_000, null);
    expectGateFail(result);
    expect(result.summary).toContain("exit code 1");
    expect(result.details).toBeDefined();
    expect((result.details as any).exitCode).toBe(1);
  });

  it("Python: runs pip/poetry/pipenv detection command", async () => {
    const vm = mockVM(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    await runBuildGate(vm, "python", 60_000, null);
    const execCall = (vm.exec as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(execCall).toContain("poetry");
    expect(execCall).toContain("pipenv");
    expect(execCall).toContain("pip install");
  });

  it("Rust: runs 'cargo build --release'", async () => {
    const vm = mockVM(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    await runBuildGate(vm, "rust", 60_000, null);
    const execCall = (vm.exec as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(execCall).toContain("cargo build --release");
  });

  it("Go: runs 'go build ./...'", async () => {
    const vm = mockVM(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    await runBuildGate(vm, "go", 60_000, null);
    const execCall = (vm.exec as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(execCall).toContain("go build ./...");
  });

  it("Unsupported language -> status 'skipped'", async () => {
    const vm = mockVM();
    const result = await runBuildGate(vm, "brainfuck", 60_000, null);
    expectGateSkipped(result);
    expect(result.summary).toContain("brainfuck");
    // exec should NOT have been called
    expect(vm.exec).not.toHaveBeenCalled();
  });

  it("passes timeoutMs to vm.exec", async () => {
    const vm = mockVM(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    await runBuildGate(vm, "typescript", 120_000, null);
    expect(vm.exec).toHaveBeenCalledWith(
      expect.any(String),
      120_000,
    );
  });

  it("_diff parameter is ignored (always full project)", async () => {
    const vm = mockVM(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const diff = mockDiffContext();
    const result = await runBuildGate(vm, "typescript", 60_000, diff);
    expectGatePass(result);
    // Build should still run full project, not scoped to diff
    const execCall = (vm.exec as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(execCall).toContain("cd /workspace");
  });

  it("truncates stderr/stdout to 5000 chars on failure", async () => {
    const longOutput = "x".repeat(6000);
    const vm = mockVM(async () => ({
      stdout: longOutput,
      stderr: longOutput,
      exitCode: 1,
    }));
    const result = await runBuildGate(vm, "typescript", 60_000, null);
    expectGateFail(result);
    const details = result.details as any;
    expect(details.stderr.length).toBeLessThan(6000);
    expect(details.stdout.length).toBeLessThan(6000);
    expect(details.stderr).toContain("truncated");
  });
});
