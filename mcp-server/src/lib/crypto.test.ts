import { describe, it, expect } from "vitest";
import { generateApiKey, hashApiKey } from "./crypto";

describe("generateApiKey", () => {
  it('returns { plaintext, hash, prefix } with plaintext starting "arc_"', () => {
    const key = generateApiKey();
    expect(key.plaintext).toMatch(/^arc_[0-9a-f]{32}$/);
    expect(key.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(key.prefix).toBe(key.plaintext.slice(0, 8));
  });

  it("plaintext is 36 chars (4 prefix + 32 hex)", () => {
    const key = generateApiKey();
    expect(key.plaintext).toHaveLength(36);
  });

  it("hash is 64-char hex (SHA-256)", () => {
    const key = generateApiKey();
    expect(key.hash).toHaveLength(64);
  });

  it("two calls produce different keys", () => {
    const key1 = generateApiKey();
    const key2 = generateApiKey();
    expect(key1.plaintext).not.toBe(key2.plaintext);
    expect(key1.hash).not.toBe(key2.hash);
  });
});

describe("hashApiKey", () => {
  it("is deterministic", () => {
    const hash1 = hashApiKey("arc_test123");
    const hash2 = hashApiKey("arc_test123");
    expect(hash1).toBe(hash2);
  });

  it("produces different hashes for different inputs", () => {
    const hash1 = hashApiKey("arc_key1");
    const hash2 = hashApiKey("arc_key2");
    expect(hash1).not.toBe(hash2);
  });
});
