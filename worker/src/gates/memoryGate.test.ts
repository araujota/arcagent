import { describe, it, expect, vi } from "vitest";
import { mockVM, expectGatePass, expectGateFail, expectGateSkipped } from "./__test-helpers__";

vi.mock("../index", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { runMemoryGate } from "./memoryGate";

describe("runMemoryGate", () => {
  it("non-C language -> 'skipped'", async () => {
    const vm = mockVM();
    const result = await runMemoryGate(vm, "typescript", 60_000, null);
    expectGateSkipped(result);
    expect(result.summary).toContain("only applies to C/C++");
  });

  it("C: Valgrind available, exit 0 -> 'pass'", async () => {
    const callIdx = 0;
    const vm = mockVM(async (cmd: string) => {
      if (cmd.includes("command -v valgrind")) {
        return { stdout: "/usr/bin/valgrind", stderr: "", exitCode: 0 };
      }
      if (cmd.includes("cat /tmp/valgrind.xml")) {
        return { stdout: "<xml></xml>", stderr: "", exitCode: 0 };
      }
      // Valgrind run itself
      return { stdout: "All heap blocks were freed", stderr: "", exitCode: 0 };
    });
    const result = await runMemoryGate(vm, "c", 60_000, null);
    expectGatePass(result);
    expect(result.summary).toContain("no memory errors");
  });

  it("C: Valgrind detects memory error (exit 42) -> 'fail'", async () => {
    const vm = mockVM(async (cmd: string) => {
      if (cmd.includes("command -v valgrind")) {
        return { stdout: "/usr/bin/valgrind", stderr: "", exitCode: 0 };
      }
      if (cmd.includes("cat /tmp/valgrind.xml")) {
        return {
          stdout: "<error><kind>UninitValue</kind><what>Use of uninitialised value</what></error>",
          stderr: "",
          exitCode: 0,
        };
      }
      // Valgrind run: exitCode 42 means memory errors
      return { stdout: "ERROR SUMMARY: 1 errors", stderr: "", exitCode: 42 };
    });
    const result = await runMemoryGate(vm, "c", 60_000, null);
    expectGateFail(result);
    expect(result.summary).toContain("memory error");
  });

  it("C++: falls back to AddressSanitizer when Valgrind unavailable", async () => {
    const execCalls: string[] = [];
    const vm = mockVM(async (cmd: string) => {
      execCalls.push(cmd);
      if (cmd.includes("command -v valgrind")) {
        return { stdout: "", stderr: "", exitCode: 1 }; // Not available
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const result = await runMemoryGate(vm, "cpp", 60_000, null);
    expectGatePass(result);
    // Should have run ASan build
    const asanCall = execCalls.find((c) => c.includes("fsanitize=address"));
    expect(asanCall).toBeDefined();
  });

  it("AddressSanitizer detects error -> 'fail'", async () => {
    const vm = mockVM(async (cmd: string) => {
      if (cmd.includes("command -v valgrind")) {
        return { stdout: "", stderr: "", exitCode: 1 };
      }
      return {
        stdout: "ERROR: AddressSanitizer: heap-buffer-overflow",
        stderr: "",
        exitCode: 1,
      };
    });
    const result = await runMemoryGate(vm, "c", 60_000, null);
    expectGateFail(result);
    expect(result.summary).toContain("AddressSanitizer");
  });
});
