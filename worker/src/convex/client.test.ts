import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { VerificationResult } from "../queue/jobQueue";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../index", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
let mockFetch: ReturnType<typeof vi.fn>;

function makeResult(overrides: Partial<VerificationResult> = {}): VerificationResult {
  return {
    jobId: "job_123",
    submissionId: "sub_456",
    bountyId: "bounty_789",
    overallStatus: "pass",
    gates: [
      { gate: "build", status: "pass", durationMs: 100, summary: "OK" },
    ],
    totalDurationMs: 500,
    jobHmac: "default_job_hmac",
    ...overrides,
  };
}

beforeEach(() => {
  mockFetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => "OK",
  });
  globalThis.fetch = mockFetch as unknown as typeof fetch;
  process.env.WORKER_SHARED_SECRET = "test-secret";
  process.env.CONVEX_URL = "https://test.convex.cloud";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
});

// ---------------------------------------------------------------------------
// Tests — import after mocks
// ---------------------------------------------------------------------------

import { postVerificationResult } from "./client";

describe("postVerificationResult", () => {
  it("includes jobHmac in POST body when present", async () => {
    const result = makeResult({ jobHmac: "abc123hmac" });
    await postVerificationResult("https://test.convex.cloud", result);

    expect(mockFetch).toHaveBeenCalled();
    const [, options] = mockFetch.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.jobHmac).toBe("abc123hmac");
    expect(typeof body.callbackTimestampMs).toBe("number");
    expect(typeof body.callbackNonce).toBe("string");
    expect(typeof body.callbackSignature).toBe("string");
  });

  it("requires jobHmac", async () => {
    const result = makeResult();
    delete (result as { jobHmac?: string }).jobHmac;
    await expect(
      postVerificationResult("https://test.convex.cloud", result),
    ).rejects.toThrow("Missing jobHmac");
  });

  it("rejects untrusted Convex URLs (C4)", async () => {
    await expect(
      postVerificationResult("https://evil.attacker.com", makeResult()),
    ).rejects.toThrow("Untrusted Convex URL");
  });

  it("allows *.convex.cloud URLs", async () => {
    await postVerificationResult("https://foo-bar-123.convex.cloud", makeResult());
    expect(mockFetch).toHaveBeenCalled();
  });

  it("posts HTTP actions to .convex.site when given a .convex.cloud deployment URL", async () => {
    await postVerificationResult("https://foo-bar-123.convex.cloud", makeResult());
    const [calledUrl] = mockFetch.mock.calls[0];
    expect(calledUrl).toBe("https://foo-bar-123.convex.site/api/verification/result");
  });

  it("allows localhost URLs", async () => {
    await postVerificationResult("http://localhost:3210", makeResult());
    expect(mockFetch).toHaveBeenCalled();
  });

  it("allows URL matching CONVEX_URL env var", async () => {
    process.env.CONVEX_URL = "https://custom-deploy.example.com";
    await postVerificationResult("https://custom-deploy.example.com", makeResult());
    expect(mockFetch).toHaveBeenCalled();
  });

  it("retries on 5xx with exponential backoff", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => "Error" })
      .mockResolvedValueOnce({ ok: false, status: 502, text: async () => "Error" })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => "OK" });

    await postVerificationResult("https://test.convex.cloud", makeResult());
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry on 4xx", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => "Bad Request",
    });

    await expect(
      postVerificationResult("https://test.convex.cloud", makeResult()),
    ).rejects.toThrow("Convex HTTP 400");

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("throws after 3 failed network attempts", async () => {
    // Network errors (as opposed to HTTP 5xx) enter the catch block
    // and trigger the "Failed after N attempts" throw
    mockFetch.mockRejectedValue(new Error("network timeout"));

    await expect(
      postVerificationResult("https://test.convex.cloud", makeResult()),
    ).rejects.toThrow("Failed to post result to Convex after 3 attempts");

    expect(mockFetch).toHaveBeenCalledTimes(3);
  }, 15_000);
});
