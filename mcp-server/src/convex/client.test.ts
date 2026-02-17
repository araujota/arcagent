import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock fetch globally
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ---------------------------------------------------------------------------
// Import module under test (must come after stubGlobal)
// ---------------------------------------------------------------------------

import { initConvexClient, callConvex } from "./client";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  initConvexClient("https://test.convex.cloud/", "shared-secret-123");
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function okResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(status: number, body: string, isJson = false) {
  return new Response(body, {
    status,
    headers: { "Content-Type": isJson ? "application/json" : "text/plain" },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("initConvexClient", () => {
  it("strips trailing slashes from URL", async () => {
    initConvexClient("https://test.convex.cloud///", "secret");
    mockFetch.mockResolvedValueOnce(okResponse({ data: true }));

    await callConvex("/api/test", { foo: "bar" });

    const calledUrl = mockFetch.mock.calls[0][0];
    expect(calledUrl).toBe("https://test.convex.cloud/api/test");
    expect(calledUrl).not.toContain("///");
  });
});

describe("callConvex", () => {
  it("happy path: correct URL, POST method, Bearer auth header, JSON body", async () => {
    mockFetch.mockResolvedValueOnce(okResponse({ result: "ok" }));

    await callConvex("/api/bounties", { bountyId: "123" });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://test.convex.cloud/api/bounties");
    expect(opts.method).toBe("POST");
    expect(opts.headers["Authorization"]).toBe("Bearer shared-secret-123");
    expect(opts.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(opts.body)).toEqual({ bountyId: "123" });
  });

  it("returns parsed JSON on 200", async () => {
    mockFetch.mockResolvedValueOnce(okResponse({ users: [1, 2, 3] }));

    const result = await callConvex<{ users: number[] }>("/api/users", {});

    expect(result).toEqual({ users: [1, 2, 3] });
  });

  it("non-OK + JSON error body → uses parsed.message", async () => {
    const body = JSON.stringify({ message: "Bounty not found" });
    mockFetch.mockResolvedValueOnce(errorResponse(404, body, true));

    await expect(callConvex("/api/bounties", {})).rejects.toThrow(
      "Bounty not found",
    );
  });

  it("non-OK + JSON with error field → uses parsed.error", async () => {
    const body = JSON.stringify({ error: "Invalid input" });
    mockFetch.mockResolvedValueOnce(errorResponse(400, body, true));

    await expect(callConvex("/api/create", {})).rejects.toThrow("Invalid input");
  });

  it("non-OK + non-JSON body + status 401 → 'Authentication failed'", async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(401, "Unauthorized"));

    await expect(callConvex("/api/secure", {})).rejects.toThrow(
      "Authentication failed",
    );
  });

  it("non-OK + non-JSON body + status 502 → 'Server error (502)'", async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(502, "<html>Bad Gateway</html>"));

    await expect(callConvex("/api/action", {})).rejects.toThrow(
      "Server error (502)",
    );
  });

  it("fetch throws AbortError → 'Convex request timed out: /path'", async () => {
    const abortError = new DOMException("The operation was aborted.", "AbortError");
    mockFetch.mockRejectedValueOnce(abortError);

    await expect(callConvex("/api/slow", {})).rejects.toThrow(
      "Convex request timed out: /api/slow",
    );
  });

  it("fetch throws regular Error → rethrows as-is", async () => {
    mockFetch.mockRejectedValueOnce(new Error("DNS resolution failed"));

    await expect(callConvex("/api/down", {})).rejects.toThrow(
      "DNS resolution failed",
    );
  });

  it("request completes within timeout → no abort", async () => {
    mockFetch.mockResolvedValueOnce(okResponse({ ok: true }));

    const result = await callConvex<{ ok: boolean }>("/api/fast", {});

    expect(result).toEqual({ ok: true });
    // If abort had fired, the request would have failed
  });

  it("non-OK + status 403 → 'Authentication failed'", async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(403, "Forbidden"));

    await expect(callConvex("/api/admin", {})).rejects.toThrow(
      "Authentication failed",
    );
  });
});
