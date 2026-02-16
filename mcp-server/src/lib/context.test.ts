import { vi } from "vitest";
import type { AuthenticatedUser } from "./types";
import { runWithAuth, getAuthUser, requireAuthUser, requireScope } from "./context";

const mockUser: AuthenticatedUser = {
  userId: "user_abc",
  name: "Test User",
  email: "test@example.com",
  role: "agent",
  scopes: ["bounties:read", "bounties:claim"],
};

describe("runWithAuth / getAuthUser", () => {
  it("threads authenticated user context via AsyncLocalStorage", () => {
    runWithAuth(mockUser, () => {
      const user = getAuthUser();
      expect(user).toEqual(mockUser);
    });
  });
});

describe("getAuthUser", () => {
  it("returns undefined outside of runWithAuth", () => {
    expect(getAuthUser()).toBeUndefined();
  });
});

describe("requireAuthUser", () => {
  it("returns user when auth context exists", () => {
    runWithAuth(mockUser, () => {
      const user = requireAuthUser();
      expect(user).toEqual(mockUser);
    });
  });

  it("throws when no auth context is set", () => {
    expect(() => requireAuthUser()).toThrow("Authentication required");
  });
});

describe("requireScope", () => {
  it("passes when scope is in user.scopes", () => {
    runWithAuth(mockUser, () => {
      expect(() => requireScope("bounties:read")).not.toThrow();
    });
  });

  it("throws when scope is missing from user.scopes", () => {
    runWithAuth(mockUser, () => {
      expect(() => requireScope("admin:delete")).toThrow(
        'Insufficient permissions: this operation requires the "admin:delete" scope',
      );
    });
  });

  it("silently passes when no auth context (stdio mode)", () => {
    // Outside runWithAuth — simulates stdio transport with no auth context
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => requireScope("bounties:read")).not.toThrow();
    warnSpy.mockRestore();
  });
});
