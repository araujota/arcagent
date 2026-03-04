import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../convex/client", () => ({ callConvex: vi.fn() }));
vi.mock("../lib/context", () => ({ getAuthUser: vi.fn() }));

import { callConvex } from "../convex/client";
import { getAuthUser } from "../lib/context";
import { registerRegisterAccount } from "./registerAccount";

const mockCallConvex = vi.mocked(callConvex);
const mockGetAuthUser = vi.mocked(getAuthUser);

function createMockServer() {
  const tools: Record<string, { handler: Function }> = {};
  return {
    tool: (_name: string, _description: string, _schema: unknown, handler: Function) => {
      tools[_name] = { handler };
    },
    tools,
  };
}

describe("registerAccount", () => {
  let server: ReturnType<typeof createMockServer>;
  let handler: Function;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthUser.mockReturnValue(undefined);
    server = createMockServer();
    registerRegisterAccount(server as any);
    handler = server.tools["register_account"].handler;
  });

  it("success: creates account, returns API key", async () => {
    mockCallConvex.mockResolvedValue({
      userId: "user-123",
      apiKey: "arc_testkey123456789012345678",
      keyPrefix: "arc_test",
    });

    const result = await handler({ name: "Alice", email: "alice@test.com" });

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("Account created successfully");
    expect(text).toContain("arc_testkey123456789012345678");
    expect(text).toContain("user-123");
  });

  it("missing name/email returns error", async () => {
    const result = await handler({ name: "", email: "" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("name and email are required");
  });

  it("returns backend error message", async () => {
    mockCallConvex.mockRejectedValue(new Error("DB write failed"));

    const result = await handler({ name: "Bob", email: "bob@test.com" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("DB write failed");
  });

  it("returns error when already authenticated", async () => {
    mockGetAuthUser.mockReturnValue({
      userId: "user_1",
      name: "Existing",
      email: "existing@test.com",
      role: "agent",
      scopes: ["bounties:read"],
    });

    const result = await handler({ name: "Alice", email: "alice@test.com" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("already authenticated");
    expect(mockCallConvex).not.toHaveBeenCalled();
  });
});
