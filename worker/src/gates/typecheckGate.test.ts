import { describe, it, expect, vi } from "vitest";
import { mockVM, mockDiffContext, expectGatePass, expectGateFail, expectGateSkipped } from "./__test-helpers__";

vi.mock("../index", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { runTypecheckGate } from "./typecheckGate";

describe("runTypecheckGate", () => {
  it("TypeScript: runs 'tsc --noEmit', exit 0 -> 'pass'", async () => {
    const vm = mockVM(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const result = await runTypecheckGate(vm, "typescript", 60_000, null);
    expectGatePass(result);
    expect(result.summary).toBe("Type check passed");
    const cmd = (vm.exec as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(cmd).toContain("tsc --noEmit");
  });

  it("TypeScript: parses error lines matching TypeScript error pattern", async () => {
    const output = [
      "src/foo.ts(10,5): error TS2345: Argument of type 'string' is not assignable",
      "src/bar.ts(20,3): error TS2322: Type 'number' is not assignable",
      "Found 2 errors.",
    ].join("\n");
    const vm = mockVM(async () => ({ stdout: output, stderr: "", exitCode: 1 }));
    const result = await runTypecheckGate(vm, "typescript", 60_000, null);
    expectGateFail(result);
    expect(result.summary).toContain("2 error(s)");
    expect((result.details as any).errorCount).toBe(2);
  });

  it("Diff-scoped: filters errors to only files in diff.changedFiles", async () => {
    const output = [
      "src/foo.ts(10,5): error TS2345: Argument of type 'string' is not assignable",
      "src/bar.ts(20,3): error TS2322: Type 'number' is not assignable",
      "src/changed.ts(5,1): error TS2339: Property does not exist",
    ].join("\n");
    const diff = mockDiffContext({
      changedFiles: ["src/changed.ts"],
    });
    const vm = mockVM(async () => ({ stdout: output, stderr: "", exitCode: 1 }));
    const result = await runTypecheckGate(vm, "typescript", 60_000, diff);
    expectGateFail(result);
    expect(result.summary).toContain("1 error(s)");
  });

  it("All errors filtered out by diff -> returns 'pass' with filteredErrors count", async () => {
    const output = [
      "src/preexisting.ts(10,5): error TS2345: Pre-existing error",
      "src/other.ts(20,3): error TS2322: Another pre-existing error",
    ].join("\n");
    const diff = mockDiffContext({
      changedFiles: ["src/new-file.ts"],
    });
    const vm = mockVM(async () => ({ stdout: output, stderr: "", exitCode: 1 }));
    const result = await runTypecheckGate(vm, "typescript", 60_000, diff);
    expectGatePass(result);
    expect(result.summary).toContain("filtered out");
    expect((result.details as any).filteredErrors).toBe(2);
    expect((result.details as any).diffScoped).toBe(true);
  });

  it("Unsupported language -> 'skipped'", async () => {
    const vm = mockVM();
    const result = await runTypecheckGate(vm, "rust", 60_000, null);
    expectGateSkipped(result);
    expect(vm.exec).not.toHaveBeenCalled();
  });

  it("Python: uses pyright or mypy", async () => {
    const vm = mockVM(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    await runTypecheckGate(vm, "python", 60_000, null);
    const cmd = (vm.exec as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(cmd).toContain("pyright");
    expect(cmd).toContain("mypy");
  });

  it("Go: runs 'go vet'", async () => {
    const vm = mockVM(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    await runTypecheckGate(vm, "go", 60_000, null);
    const cmd = (vm.exec as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(cmd).toContain("go vet");
  });

  it("Java -> 'skipped' (type checking covered by build)", async () => {
    const vm = mockVM();
    const result = await runTypecheckGate(vm, "java", 60_000, null);
    expectGateSkipped(result);
    expect(result.status).toBe("skipped");
  });
});
