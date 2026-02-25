import type { AuthenticatedUser } from "./types";
import { runWithAuth, getAuthUser, requireAuthUser, requireScope, setStdioAuthUser } from "./context";

const mockUser: AuthenticatedUser = {
  userId: "user_abc",
  name: "Test User",
  email: "test@example.com",
  role: "agent",
  scopes: ["bounties:read", "bounties:claim"],
};

const otherUser: AuthenticatedUser = {
  userId: "user_xyz",
  name: "Other User",
  email: "other@example.com",
  role: "creator",
  scopes: ["bounties:create", "repos:read"],
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

  it("throws when no auth context is set", () => {
    // Outside runWithAuth with no stdio user set
    expect(() => requireScope("bounties:read")).toThrow(
      'Authentication required: cannot verify required "bounties:read" scope',
    );
  });

  it("throws when user has empty scopes array", () => {
    const emptyScopes: AuthenticatedUser = {
      ...mockUser,
      scopes: [],
    };
    runWithAuth(emptyScopes, () => {
      expect(() => requireScope("bounties:read")).toThrow(
        'Insufficient permissions: this operation requires the "bounties:read" scope',
      );
    });
  });

  it("supports stdio-authenticated users", () => {
    setStdioAuthUser(mockUser);
    expect(() => requireScope("bounties:read")).not.toThrow();
  });
});

describe("runWithAuth — async propagation", () => {
  it("context propagates through await", async () => {
    await runWithAuth(mockUser, async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const user = getAuthUser();
      expect(user).toEqual(mockUser);
    });
  });

  it("nested runWithAuth — inner overrides outer", () => {
    runWithAuth(mockUser, () => {
      expect(getAuthUser()).toEqual(mockUser);

      runWithAuth(otherUser, () => {
        expect(getAuthUser()).toEqual(otherUser);
      });
    });
  });

  it("after inner runWithAuth returns, outer context restored", () => {
    runWithAuth(mockUser, () => {
      runWithAuth(otherUser, () => {
        // inner context
      });
      // Outer context should be restored
      expect(getAuthUser()).toEqual(mockUser);
    });
  });

  it("two concurrent async contexts see their own user (Promise.all isolation)", async () => {
    const results: string[] = [];

    await Promise.all([
      runWithAuth(mockUser, async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        const user = getAuthUser();
        results.push(user!.userId);
      }),
      runWithAuth(otherUser, async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        const user = getAuthUser();
        results.push(user!.userId);
      }),
    ]);

    // Both contexts should see their own user — order doesn't matter
    expect(results).toContain("user_abc");
    expect(results).toContain("user_xyz");
    expect(results).toHaveLength(2);
  });
});

describe("setStdioAuthUser", () => {
  it("getAuthUser returns stdio user outside runWithAuth", () => {
    setStdioAuthUser(mockUser);
    // Outside runWithAuth, should fall back to stdio user
    const user = getAuthUser();
    expect(user).toEqual(mockUser);
  });

  it("runWithAuth takes precedence over stdioUser when both set", () => {
    setStdioAuthUser(mockUser);

    runWithAuth(otherUser, () => {
      const user = getAuthUser();
      expect(user).toEqual(otherUser);
    });
  });
});
