import { describe, it, expect } from "vitest";
import { generateJobHmac, verifyJobHmac } from "./hmac";

describe("job HMAC", () => {
  it("uses WORKER_API_SECRET fallback consistently for generate + verify", async () => {
    const originalShared = process.env.WORKER_SHARED_SECRET;
    const originalApi = process.env.WORKER_API_SECRET;
    delete process.env.WORKER_SHARED_SECRET;
    process.env.WORKER_API_SECRET = "fallback_secret";

    try {
      const token = await generateJobHmac("v1", "s1", "b1");
      const valid = await verifyJobHmac(token, "v1", "s1", "b1");
      expect(valid).toBe(true);
    } finally {
      if (originalShared === undefined) delete process.env.WORKER_SHARED_SECRET;
      else process.env.WORKER_SHARED_SECRET = originalShared;
      if (originalApi === undefined) delete process.env.WORKER_API_SECRET;
      else process.env.WORKER_API_SECRET = originalApi;
    }
  });
});
