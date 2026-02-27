import { describe, it, expect, afterEach, vi } from "vitest";
import { access } from "node:fs/promises";
import { createProcessVM, destroyProcessVM, isProcessHandle } from "./processBackend";

vi.mock("../index", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

async function mkHandle() {
  const handle = await createProcessVM({
    jobId: "job-test",
    rootfsImage: "node-20.ext4",
    vcpuCount: 2,
    memSizeMib: 1024,
  });

  if (!isProcessHandle(handle)) {
    throw new Error("Expected process backend handle");
  }

  return handle;
}

describe("process backend (Cloudflare mode)", () => {
  afterEach(async () => {
    // No-op safeguard; each test destroys its own handle.
  });

  it("exec rewrites /workspace paths and runs in isolated temp workspace", async () => {
    const handle = await mkHandle();
    try {
      const result = await handle.exec(
        "mkdir -p /workspace/src && echo 'hello' > /workspace/src/a.txt && cat /workspace/src/a.txt",
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("hello");
    } finally {
      await destroyProcessVM(handle);
    }
  });

  it("supports session_create + session_exec with persistent cwd", async () => {
    const handle = await mkHandle();
    try {
      const created = await handle.vsockRequest!({
        type: "session_create",
        sessionId: "default",
      });
      expect(created.type).toBe("session_result");
      expect(created.sessionId).toBe("default");

      const first = await handle.vsockRequest!({
        type: "session_exec",
        sessionId: "default",
        command: "cd /workspace && mkdir -p nested && cd nested && pwd",
      });
      expect(first.type).toBe("session_result");
      expect(first.exitCode).toBe(0);
      expect(first.cwd).toBe("/workspace/nested");

      const second = await handle.vsockRequest!({
        type: "session_exec",
        sessionId: "default",
        command: "pwd",
      });
      expect(second.type).toBe("session_result");
      expect(second.exitCode).toBe(0);
      expect(second.cwd).toBe("/workspace/nested");
      expect((second.stdout ?? "").trim()).toContain("nested");
    } finally {
      await destroyProcessVM(handle);
    }
  });

  it("supports file_edit via vsockRequest", async () => {
    const handle = await mkHandle();
    try {
      await handle.writeFile!("/workspace/readme.txt", Buffer.from("alpha\nbeta\n"));

      const edited = await handle.vsockRequest!({
        type: "file_edit",
        path: "/workspace/readme.txt",
        oldString: "beta",
        newString: "gamma",
      });

      expect(edited.type).toBe("file_result");
      expect(edited.replacements).toBe(1);
      expect(edited.error).toBeUndefined();

      const readBack = await handle.exec("cat /workspace/readme.txt");
      expect(readBack.exitCode).toBe(0);
      expect(readBack.stdout).toContain("gamma");
      expect(readBack.stdout).not.toContain("beta");
    } finally {
      await destroyProcessVM(handle);
    }
  });

  it("destroy removes the isolated root directory", async () => {
    const handle = await mkHandle();
    const rootDir = handle.__rootDir;

    await destroyProcessVM(handle);

    await expect(access(rootDir)).rejects.toBeDefined();
  });

  it("scrubs worker secrets from child command environment", async () => {
    const previous = process.env.WORKER_SHARED_SECRET;
    process.env.WORKER_SHARED_SECRET = "top-secret";

    const handle = await mkHandle();
    try {
      const result = await handle.exec("printf '%s' \"$WORKER_SHARED_SECRET\"");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
    } finally {
      await destroyProcessVM(handle);
      if (previous === undefined) {
        delete process.env.WORKER_SHARED_SECRET;
      } else {
        process.env.WORKER_SHARED_SECRET = previous;
      }
    }
  });
});
