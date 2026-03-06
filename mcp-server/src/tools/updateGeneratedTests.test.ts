import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../convex/client", () => ({ callConvex: vi.fn() }));
vi.mock("../worker/client", () => ({ callWorker: vi.fn() }));

import { callConvex } from "../convex/client";
import { registerUpdateGeneratedTests } from "./updateGeneratedTests";
import { runWithAuth } from "../lib/context";
import { AuthenticatedUser } from "../lib/types";

const mockCallConvex = vi.mocked(callConvex);

function createMockServer() {
  const tools: Record<string, { handler: Function }> = {};
  return {
    tool: (_name: string, _desc: string, _schema: unknown, handler: Function) => {
      tools[_name] = { handler };
    },
    tools,
  };
}

const testUser: AuthenticatedUser = {
  userId: "user_creator",
  name: "Creator",
  email: "creator@test.com",
  role: "creator",
  scopes: ["bounties:create"],
};

describe("update_generated_tests tool", () => {
  let handler: Function;

  beforeEach(() => {
    vi.clearAllMocks();
    const server = createMockServer();
    registerUpdateGeneratedTests(server as any);
    handler = server.tools["update_generated_tests"].handler;
  });

  it("saves edited generated tests", async () => {
    mockCallConvex.mockResolvedValue({ ok: true, action: "save" });

    const result = await runWithAuth(testUser, () =>
      handler({
        bountyId: "b1",
        action: "save",
        gherkinPublic: "Feature: Updated",
        nativeTestFilesPublic: "[]",
      }),
    );

    expect(mockCallConvex).toHaveBeenCalledWith(
      "/api/mcp/bounties/tests/update",
      {
        bountyId: "b1",
        action: "save",
        gherkinPublic: "Feature: Updated",
        nativeTestFilesPublic: "[]",
      },
    );
    expect(result.content[0].text).toContain("Action:** save");
  });
});
