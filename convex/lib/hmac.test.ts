import { describe, it, expect, beforeEach } from "vitest";
import { generateJobHmac, verifyJobHmac } from "./hmac";

describe("HMAC (H6)", () => {
  beforeEach(() => {
    process.env.WORKER_SHARED_SECRET = "test-hmac-secret";
  });

  it("round-trip: generate then verify returns true", async () => {
    const hmac = await generateJobHmac("v1", "s1", "b1");
    const valid = await verifyJobHmac(hmac, "v1", "s1", "b1");
    expect(valid).toBe(true);
  });

  it("tampered HMAC returns false", async () => {
    const hmac = await generateJobHmac("v1", "s1", "b1");
    const tampered = hmac.slice(0, -2) + "ff";
    const valid = await verifyJobHmac(tampered, "v1", "s1", "b1");
    expect(valid).toBe(false);
  });

  it("wrong verificationId returns false", async () => {
    const hmac = await generateJobHmac("v1", "s1", "b1");
    const valid = await verifyJobHmac(hmac, "v_wrong", "s1", "b1");
    expect(valid).toBe(false);
  });

  it("wrong submissionId returns false", async () => {
    const hmac = await generateJobHmac("v1", "s1", "b1");
    const valid = await verifyJobHmac(hmac, "v1", "s_wrong", "b1");
    expect(valid).toBe(false);
  });

  it("wrong bountyId returns false", async () => {
    const hmac = await generateJobHmac("v1", "s1", "b1");
    const valid = await verifyJobHmac(hmac, "v1", "s1", "b_wrong");
    expect(valid).toBe(false);
  });

  it("generates hex string of expected length (SHA-256 = 64 hex chars)", async () => {
    const hmac = await generateJobHmac("v1", "s1", "b1");
    expect(hmac).toMatch(/^[0-9a-f]{64}$/);
  });

  it("same inputs produce same HMAC (deterministic)", async () => {
    const hmac1 = await generateJobHmac("v1", "s1", "b1");
    const hmac2 = await generateJobHmac("v1", "s1", "b1");
    expect(hmac1).toBe(hmac2);
  });

  it("different inputs produce different HMACs", async () => {
    const hmac1 = await generateJobHmac("v1", "s1", "b1");
    const hmac2 = await generateJobHmac("v2", "s1", "b1");
    expect(hmac1).not.toBe(hmac2);
  });
});
