import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../convex/client", () => ({ callConvex: vi.fn() }));
vi.mock("../lib/clerk", () => ({ findOrCreateClerkUser: vi.fn() }));

import { callConvex } from "../convex/client";
import { findOrCreateClerkUser } from "../lib/clerk";
import { registerRegisterAccount } from "./registerAccount";

const mockCallConvex = vi.mocked(callConvex);
const mockFindOrCreateClerkUser = vi.mocked(findOrCreateClerkUser);

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
    server = createMockServer();
    registerRegisterAccount(server as any);
    handler = server.tools["register_account"].handler;
  });

  it("success: creates account, returns API key", async () => {
    mockFindOrCreateClerkUser.mockResolvedValue({
      clerkId: "user_2abc",
      isExisting: false,
    });
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

  it("error after Clerk creation includes clerkId in message", async () => {
    mockFindOrCreateClerkUser.mockResolvedValue({
      clerkId: "user_2xyz",
      isExisting: false,
    });
    mockCallConvex.mockRejectedValue(new Error("DB write failed"));

    const result = await handler({ name: "Bob", email: "bob@test.com" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("DB write failed");
    expect(result.content[0].text).toContain("user_2xyz");
  });

  it("links existing account when isExisting is true", async () => {
    mockFindOrCreateClerkUser.mockResolvedValue({
      clerkId: "user_existing",
      isExisting: true,
    });
    mockCallConvex.mockResolvedValue({
      userId: "user-456",
      apiKey: "arc_testkey123456789012345678",
      keyPrefix: "arc_test",
    });

    const result = await handler({ name: "Carol", email: "carol@test.com" });

    const text = result.content[0].text;
    expect(text).toContain("Linked to your existing arcagent account");
  });
});
