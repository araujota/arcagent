import { describe, it, expect, vi } from "vitest";
import { mockVM, mockDiffContext, expectGatePass, expectGateFail, expectGateSkipped } from "./__test-helpers__";

vi.mock("../index", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { runLintGate } from "./lintGate";

describe("runLintGate", () => {
  it("TypeScript with no diff -> runs eslint on full project ('.')", async () => {
    const vm = mockVM(async () => ({ stdout: "[]", stderr: "", exitCode: 0 }));
    await runLintGate(vm, "typescript", 60_000, null);
    const cmd = (vm.exec as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(cmd).toContain("npx eslint .");
  });

  it("TypeScript with diff -> only passes changed .ts/.tsx files", async () => {
    const diff = mockDiffContext({
      changedFiles: ["src/foo.ts", "src/bar.tsx", "README.md"],
    });
    const vm = mockVM(async () => ({ stdout: "[]", stderr: "", exitCode: 0 }));
    await runLintGate(vm, "typescript", 60_000, diff);
    const cmd = (vm.exec as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(cmd).toContain("'src/foo.ts'");
    expect(cmd).toContain("'src/bar.tsx'");
    expect(cmd).not.toContain("README.md");
  });

  it("Exit 0 -> 'pass'", async () => {
    const vm = mockVM(async () => ({ stdout: "[]", stderr: "", exitCode: 0 }));
    const result = await runLintGate(vm, "typescript", 60_000, null);
    expectGatePass(result);
    expect(result.summary).toContain("no issues");
  });

  it("Non-zero exit -> 'fail' with issue count", async () => {
    const eslintOutput = JSON.stringify([
      { filePath: "src/a.ts", errorCount: 2, warningCount: 1 },
      { filePath: "src/b.ts", errorCount: 0, warningCount: 3 },
    ]);
    const vm = mockVM(async () => ({ stdout: eslintOutput, stderr: "", exitCode: 1 }));
    const result = await runLintGate(vm, "typescript", 60_000, null);
    expectGateFail(result);
    expect(result.summary).toContain("6 issue(s)");
  });

  it("Python -> runs ruff", async () => {
    const vm = mockVM(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    await runLintGate(vm, "python", 60_000, null);
    const cmd = (vm.exec as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(cmd).toContain("ruff check");
  });

  it("Ruby -> runs rubocop", async () => {
    const vm = mockVM(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    await runLintGate(vm, "ruby", 60_000, null);
    const cmd = (vm.exec as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(cmd).toContain("rubocop");
  });

  it("Unsupported language -> 'skipped'", async () => {
    const vm = mockVM();
    const result = await runLintGate(vm, "brainfuck", 60_000, null);
    expectGateSkipped(result);
    expect(vm.exec).not.toHaveBeenCalled();
  });

  it("Diff with no matching extensions -> full-project lint", async () => {
    const diff = mockDiffContext({
      changedFiles: ["README.md", "docs/guide.txt"],
    });
    const vm = mockVM(async () => ({ stdout: "[]", stderr: "", exitCode: 0 }));
    await runLintGate(vm, "typescript", 60_000, diff);
    const cmd = (vm.exec as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    // Falls back to full project since no .ts/.tsx/.js/.jsx changed
    expect(cmd).toContain("npx eslint .");
  });

  it("Go -> runs golangci-lint", async () => {
    const vm = mockVM(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    await runLintGate(vm, "go", 60_000, null);
    const cmd = (vm.exec as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(cmd).toContain("golangci-lint");
  });

  it("Rust -> runs cargo clippy (full project, not diff-scoped)", async () => {
    const vm = mockVM(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    await runLintGate(vm, "rust", 60_000, null);
    const cmd = (vm.exec as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(cmd).toContain("cargo clippy");
  });
});
