import { describe, it, expect } from "vitest";
import { generateJobHmac, verifyJobHmac } from "./hmac";

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
});
