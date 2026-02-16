import { vi } from "vitest";
import type { AuthenticatedUser } from "../lib/types";

const VALID_KEY = "arc_" + "a".repeat(32); // 36 chars total

const mockUser: AuthenticatedUser = {
  userId: "user_123",
  name: "Test Agent",
  email: "agent@test.com",
  role: "agent",
  scopes: ["bounties:read", "bounties:claim"],
};

const validConvexResponse = {
  valid: true,
  userId: mockUser.userId,
  user: {
    _id: mockUser.userId,
    name: mockUser.name,
    email: mockUser.email,
    role: mockUser.role,
  },
  scopes: mockUser.scopes,
};

// We use dynamic imports so vi.resetModules() gives us a fresh cache each test.
// Shared mock function references that survive module resets.
const mockHashApiKey = vi.fn().mockReturnValue("mocked-sha256-hash");
const mockCallConvex = vi.fn();

describe("validateApiKey", () => {
  let validateApiKey: (typeof import("./apiKeyAuth"))["validateApiKey"];
  let ApiKeyFormatError: (typeof import("./apiKeyAuth"))["ApiKeyFormatError"];

  beforeEach(async () => {
    vi.useFakeTimers();
    mockHashApiKey.mockClear();
    mockCallConvex.mockClear();
    // Reset modules to get a fresh module-level cache Map
    vi.resetModules();
    vi.doMock("../lib/crypto", () => ({ hashApiKey: mockHashApiKey }));
    vi.doMock("../convex/client", () => ({ callConvex: mockCallConvex }));
    const mod = await import("./apiKeyAuth");
    validateApiKey = mod.validateApiKey;
    ApiKeyFormatError = mod.ApiKeyFormatError;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("throws ApiKeyFormatError if key does not start with 'arc_'", async () => {
    await expect(validateApiKey("bad_12345678901234567890123456789012")).rejects.toThrow(
      ApiKeyFormatError,
    );
    await expect(validateApiKey("bad_12345678901234567890123456789012")).rejects.toThrow(
      "API key must start with 'arc_'",
    );
  });

  it("throws ApiKeyFormatError with character count if key is not 36 chars", async () => {
    const shortKey = "arc_tooshort";
    await expect(validateApiKey(shortKey)).rejects.toThrow(ApiKeyFormatError);
    await expect(validateApiKey(shortKey)).rejects.toThrow(
      `API key must be 36 characters (got ${shortKey.length})`,
    );
  });

  it("calls Convex with SHA-256 hash on valid format", async () => {
    mockCallConvex.mockResolvedValueOnce(validConvexResponse);

    await validateApiKey(VALID_KEY);

    expect(mockHashApiKey).toHaveBeenCalledWith(VALID_KEY);
    expect(mockCallConvex).toHaveBeenCalledWith("/api/mcp/auth/validate", {
      keyHash: "mocked-sha256-hash",
    });
  });

  it("returns AuthenticatedUser on valid key", async () => {
    mockCallConvex.mockResolvedValueOnce(validConvexResponse);

    const result = await validateApiKey(VALID_KEY);

    expect(result).toEqual(mockUser);
  });

  it("caches results for 60s — second call within TTL skips Convex", async () => {
    mockCallConvex.mockResolvedValueOnce(validConvexResponse);

    const first = await validateApiKey(VALID_KEY);

    // Advance 30s — still within 60s TTL
    vi.advanceTimersByTime(30_000);

    const second = await validateApiKey(VALID_KEY);

    expect(mockCallConvex).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("refetches after TTL expires", async () => {
    mockCallConvex
      .mockResolvedValueOnce(validConvexResponse)
      .mockResolvedValueOnce(validConvexResponse);

    await validateApiKey(VALID_KEY);
    expect(mockCallConvex).toHaveBeenCalledTimes(1);

    // Advance past the 60s TTL
    vi.advanceTimersByTime(61_000);

    await validateApiKey(VALID_KEY);
    expect(mockCallConvex).toHaveBeenCalledTimes(2);
  });

  it("throws ApiKeyFormatError when Convex returns invalid result", async () => {
    mockCallConvex.mockResolvedValueOnce({ valid: false });

    await expect(validateApiKey(VALID_KEY)).rejects.toThrow(ApiKeyFormatError);
  });
});

describe("extractApiKey", () => {
  let extractApiKey: (typeof import("./apiKeyAuth"))["extractApiKey"];

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("../lib/crypto", () => ({ hashApiKey: mockHashApiKey }));
    vi.doMock("../convex/client", () => ({ callConvex: mockCallConvex }));
    const mod = await import("./apiKeyAuth");
    extractApiKey = mod.extractApiKey;
  });

  it("strips 'Bearer ' prefix and returns the key", () => {
    expect(extractApiKey("Bearer arc_abc123")).toBe("arc_abc123");
  });

  it("returns null for missing or malformed header", () => {
    expect(extractApiKey("")).toBe(null);
    expect(extractApiKey("Basic abc123")).toBe(null);
    expect(extractApiKey("bearer arc_abc123")).toBe(null); // lowercase
  });

  it("returns null for undefined", () => {
    expect(extractApiKey(undefined)).toBe(null);
  });
});
