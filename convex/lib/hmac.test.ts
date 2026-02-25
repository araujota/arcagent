import { describe, it, expect } from "vitest";
import {
  generateJobHmac,
  verifyJobHmac,
  generateWorkerCallbackSignature,
  verifyWorkerCallbackSignature,
  isFreshWorkerCallbackTimestamp,
} from "./hmac";

describe("job HMAC", () => {
  it("uses WORKER_SHARED_SECRET consistently for generate + verify", async () => {
    const originalShared = process.env.WORKER_SHARED_SECRET;
    process.env.WORKER_SHARED_SECRET = "test_shared_secret";

    try {
      const token = await generateJobHmac("v1", "s1", "b1");
      const valid = await verifyJobHmac(token, "v1", "s1", "b1");
      expect(valid).toBe(true);
    } finally {
      if (originalShared === undefined) delete process.env.WORKER_SHARED_SECRET;
      else process.env.WORKER_SHARED_SECRET = originalShared;
    }
  });

  it("signs and verifies callback envelopes", async () => {
    const originalShared = process.env.WORKER_SHARED_SECRET;
    process.env.WORKER_SHARED_SECRET = "test_shared_secret";

    try {
      const callbackTimestampMs = Date.now();
      const params = {
        submissionId: "s1",
        bountyId: "b1",
        jobId: "j1",
        overallStatus: "pass",
        jobHmac: "hmac123",
        callbackTimestampMs,
        callbackNonce: "nonce_abc",
      };
      const signature = await generateWorkerCallbackSignature(params);
      const valid = await verifyWorkerCallbackSignature(signature, params);
      expect(valid).toBe(true);
    } finally {
      if (originalShared === undefined) delete process.env.WORKER_SHARED_SECRET;
      else process.env.WORKER_SHARED_SECRET = originalShared;
    }
  });

  it("rejects stale callback timestamps", () => {
    const now = Date.now();
    expect(isFreshWorkerCallbackTimestamp(now - 1000, now)).toBe(true);
    expect(isFreshWorkerCallbackTimestamp(now - 6 * 60 * 1000, now)).toBe(false);
    expect(isFreshWorkerCallbackTimestamp(now + 60 * 1000, now)).toBe(false);
  });
});
