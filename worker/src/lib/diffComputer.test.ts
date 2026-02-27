import { describe, expect, it, vi } from "vitest";
import type { VMHandle } from "../vm/firecracker";

vi.mock("../index", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { computeDiff } from "./diffComputer";

function makeVm(execImpl: VMHandle["exec"]): VMHandle {
  return {
    vmId: "vm-test",
    jobId: "job-test",
    guestIp: "10.0.0.2",
    exec: execImpl,
  };
}

describe("computeDiff", () => {
  it("uses commit-vs-commit diff when an agent commit ref is provided", async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "src/a.ts\n", stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({
        stdout: "diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n@@ -1,0 +2,2 @@\n+one\n+two\n",
        stderr: "",
        exitCode: 0,
      });
    const vm = makeVm(exec as VMHandle["exec"]);

    const diff = await computeDiff(vm, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");

    expect(exec).toHaveBeenNthCalledWith(
      1,
      "cd /workspace && git diff --name-only 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'..'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' 2>&1",
      30_000,
    );
    expect(exec).toHaveBeenNthCalledWith(
      2,
      "cd /workspace && git diff -U0 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'..'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' 2>&1",
      30_000,
    );
    expect(diff?.changedFiles).toEqual(["src/a.ts"]);
    expect(diff?.changedLineRanges.get("src/a.ts")).toEqual([[2, 3]]);
  });

  it("uses base-vs-working-tree diff for WORKTREE sentinel", async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "src/b.ts\n", stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({
        stdout: "diff --git a/src/b.ts b/src/b.ts\n+++ b/src/b.ts\n@@ -10,0 +11,1 @@\n+x\n",
        stderr: "",
        exitCode: 0,
      });
    const vm = makeVm(exec as VMHandle["exec"]);

    const diff = await computeDiff(vm, "cccccccccccccccccccccccccccccccccccccccc", "WORKTREE");

    expect(exec).toHaveBeenNthCalledWith(
      1,
      "cd /workspace && git diff --name-only 'cccccccccccccccccccccccccccccccccccccccc' -- 2>&1",
      30_000,
    );
    expect(exec).toHaveBeenNthCalledWith(
      2,
      "cd /workspace && git diff -U0 'cccccccccccccccccccccccccccccccccccccccc' -- 2>&1",
      30_000,
    );
    expect(diff?.changedFiles).toEqual(["src/b.ts"]);
    expect(diff?.changedLineRanges.get("src/b.ts")).toEqual([[11, 11]]);
  });
});
