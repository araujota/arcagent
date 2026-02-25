import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../convex/client", () => ({ callConvex: vi.fn() }));
vi.mock("../worker/client", () => ({ callWorker: vi.fn() }));

import { callConvex } from "../convex/client";
import { registerGetTestSuites } from "./getTestSuites";
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
  userId: "user_agent",
  name: "Agent",
  email: "agent@test.com",
  role: "agent",
  scopes: ["bounties:read"],
};

describe("get_test_suites tool", () => {
  let handler: Function;

  beforeEach(() => {
    vi.clearAllMocks();
    const server = createMockServer();
    registerGetTestSuites(server as any);
    handler = server.tools["get_test_suites"].handler;
  });

  it("renders public suites with framework metadata", async () => {
    mockCallConvex.mockResolvedValue({
      testSuites: [
        { title: "Auth", version: 1, gherkinContent: "Feature: Auth\n  Scenario: Login", visibility: "public" },
      ],
      testFramework: "vitest",
      testLanguage: "typescript",
    });

    const result = await runWithAuth(testUser, () =>
      handler({ bountyId: "b1" }),
    );

    const text = result.content[0].text;
    expect(text).toContain("Public Test Suites (1)");
    expect(text).toContain("vitest");
    expect(text).toContain("Auth");
    expect(text).not.toContain("Hidden Test Suites");
  });

  it("empty suites -> generation hint message", async () => {
    mockCallConvex.mockResolvedValue({
      testSuites: [],
      testFramework: null,
      testLanguage: null,
    });

    const result = await runWithAuth(testUser, () =>
      handler({ bountyId: "b1" }),
    );

    expect(result.content[0].text).toContain("No test suites found");
  });

  it("scope enforcement -> requires bounties:read", async () => {
    const noScopeUser: AuthenticatedUser = { ...testUser, scopes: [] };
    await expect(
      runWithAuth(noScopeUser, () => handler({ bountyId: "b1" })),
    ).rejects.toThrow();
  });
});
