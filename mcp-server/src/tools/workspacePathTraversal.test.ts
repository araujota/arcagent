import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock external modules
vi.mock("../convex/client", () => ({ callConvex: vi.fn() }));
vi.mock("../worker/client", () => ({ callWorker: vi.fn() }));
vi.mock("../workspace/cache", () => ({
  getWorkspaceForAgent: vi.fn(),
}));

import { callWorker } from "../worker/client";
import { getWorkspaceForAgent } from "../workspace/cache";
import { registerWorkspaceReadFile } from "./workspaceReadFile";
import { registerWorkspaceWriteFile } from "./workspaceWriteFile";
import { registerWorkspaceListFiles } from "./workspaceListFiles";
import { registerWorkspaceApplyPatch, parseV4APatch } from "./workspaceApplyPatch";
import { runWithAuth } from "../lib/context";
import { AuthenticatedUser } from "../lib/types";

const mockCallWorker = vi.mocked(callWorker);
const mockGetWorkspace = vi.mocked(getWorkspaceForAgent);

function createMockServer() {
  const tools: Record<string, { handler: Function }> = {};
  return {
    tool: (_name: string, _description: string, _schema: unknown, handler: Function) => {
      tools[_name] = { handler };
    },
    tools,
  };
}

const testUser: AuthenticatedUser = {
  userId: "user_test",
  name: "Test User",
  email: "test@example.com",
  role: "agent",
  scopes: ["workspace:read", "workspace:write", "bounties:read", "bounties:claim"],
};

const readyWorkspace = {
  found: true,
  status: "ready",
  workspaceId: "ws-123",
  workerHost: "http://worker:3001",
};

// ---------------------------------------------------------------------------
// W3 Path Traversal tests across all workspace tools
// ---------------------------------------------------------------------------

describe("W3 path traversal guard — workspaceReadFile", () => {
  let handler: Function;

  beforeEach(() => {
    vi.clearAllMocks();
    const server = createMockServer();
    registerWorkspaceReadFile(server as any);
    handler = server.tools["workspace_read_file"].handler;
    mockGetWorkspace.mockResolvedValue(readyWorkspace as any);
  });

  it("rejects ../etc/passwd -> 'Path traversal not allowed'", async () => {
    const result = await runWithAuth(testUser, () =>
      handler({ bountyId: "b1", path: "../etc/passwd" }),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Path traversal not allowed");
  });

  it("rejects foo/../../etc/shadow -> embedded traversal blocked", async () => {
    const result = await runWithAuth(testUser, () =>
      handler({ bountyId: "b1", path: "foo/../../etc/shadow" }),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Path traversal not allowed");
  });

  it("allows /workspace/../workspace/file.ts -> starts with /workspace/", async () => {
    mockCallWorker.mockResolvedValue({
      content: "hello",
      path: "/workspace/file.ts",
      totalLines: 1,
      startLine: 1,
      linesReturned: 1,
      isBinary: false,
    } as any);
    const result = await runWithAuth(testUser, () =>
      handler({ bountyId: "b1", path: "/workspace/../workspace/file.ts" }),
    );
    expect(result.isError).toBeUndefined();
  });

  it("allows src/main.ts -> no '..', passes", async () => {
    mockCallWorker.mockResolvedValue({
      content: "code",
      path: "src/main.ts",
      totalLines: 1,
      startLine: 1,
      linesReturned: 1,
      isBinary: false,
    } as any);
    const result = await runWithAuth(testUser, () =>
      handler({ bountyId: "b1", path: "src/main.ts" }),
    );
    expect(result.isError).toBeUndefined();
  });
});

describe("W3 path traversal guard — workspaceWriteFile", () => {
  let handler: Function;

  beforeEach(() => {
    vi.clearAllMocks();
    const server = createMockServer();
    registerWorkspaceWriteFile(server as any);
    handler = server.tools["workspace_write_file"].handler;
    mockGetWorkspace.mockResolvedValue(readyWorkspace as any);
  });

  it("rejects ../etc/passwd", async () => {
    const result = await runWithAuth(testUser, () =>
      handler({ bountyId: "b1", path: "../etc/passwd", content: "malicious" }),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Path traversal not allowed");
  });

  it("allows src/main.ts", async () => {
    mockCallWorker.mockResolvedValue({ bytesWritten: 10 } as any);
    const result = await runWithAuth(testUser, () =>
      handler({ bountyId: "b1", path: "src/main.ts", content: "hello" }),
    );
    expect(result.isError).toBeUndefined();
  });

  it("rejects content > 1MB", async () => {
    const bigContent = "x".repeat(1024 * 1024 + 1);
    const result = await runWithAuth(testUser, () =>
      handler({ bountyId: "b1", path: "src/main.ts", content: bigContent }),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("too large");
  });
});

describe("W3 path traversal guard — workspaceApplyPatch", () => {
  let handler: Function;

  beforeEach(() => {
    vi.clearAllMocks();
    const server = createMockServer();
    registerWorkspaceApplyPatch(server as any);
    handler = server.tools["workspace_apply_patch"].handler;
    mockGetWorkspace.mockResolvedValue(readyWorkspace as any);
  });

  it("rejects traversal in patch file paths", async () => {
    const patch = `*** Begin Patch
*** Add File: ../etc/malicious.sh
+#!/bin/bash
+rm -rf /
*** End Patch`;
    const result = await runWithAuth(testUser, () =>
      handler({ bountyId: "b1", patch }),
    );
    // The patch tool applies operations individually and reports per-op errors
    expect(result.content[0].text).toContain("path traversal not allowed");
  });

  it("allows valid patch paths", async () => {
    mockCallWorker.mockResolvedValue({ bytesWritten: 10 } as any);
    const patch = `*** Begin Patch
*** Add File: src/newfile.ts
+export const foo = "bar";
*** End Patch`;
    const result = await runWithAuth(testUser, () =>
      handler({ bountyId: "b1", patch }),
    );
    expect(result.isError).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// parseV4APatch (pure function)
// ---------------------------------------------------------------------------

describe("parseV4APatch", () => {
  it("parses '*** Add File:' with '+' lines", () => {
    const patch = `*** Begin Patch
*** Add File: src/new.ts
+export const x = 1;
+export const y = 2;
*** End Patch`;
    const ops = parseV4APatch(patch);
    expect(ops).toHaveLength(1);
    expect(ops[0].type).toBe("add");
    expect(ops[0].path).toBe("src/new.ts");
    expect(ops[0].addLines).toEqual(["export const x = 1;", "export const y = 2;"]);
  });

  it("parses '*** Delete File:'", () => {
    const patch = `*** Begin Patch
*** Delete File: src/old.ts
*** End Patch`;
    const ops = parseV4APatch(patch);
    expect(ops).toHaveLength(1);
    expect(ops[0].type).toBe("delete");
    expect(ops[0].path).toBe("src/old.ts");
  });

  it("parses '*** Update File:' with @@ anchors", () => {
    const patch = `*** Begin Patch
*** Update File: src/index.ts
@@ export function foo() {
-  return 1;
+  return 2;
*** End Patch`;
    const ops = parseV4APatch(patch);
    expect(ops).toHaveLength(1);
    expect(ops[0].type).toBe("update");
    expect(ops[0].path).toBe("src/index.ts");
    expect(ops[0].sections).toHaveLength(1);
    expect(ops[0].sections![0].anchor).toBe("export function foo() {");
    expect(ops[0].sections![0].changes).toHaveLength(2);
  });

  it("handles multiple operations in one patch", () => {
    const patch = `*** Begin Patch
*** Add File: src/a.ts
+export const a = 1;
*** Delete File: src/b.ts
*** Update File: src/c.ts
@@ const x = 1;
-const y = 2;
+const y = 3;
*** End Patch`;
    const ops = parseV4APatch(patch);
    expect(ops).toHaveLength(3);
    expect(ops[0].type).toBe("add");
    expect(ops[1].type).toBe("delete");
    expect(ops[2].type).toBe("update");
  });

  it("missing 'Begin Patch' -> throws", () => {
    expect(() => parseV4APatch("*** Add File: x.ts\n+hello")).toThrow(
      "missing '*** Begin Patch'",
    );
  });
});
