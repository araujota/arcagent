import { describe, it, expect } from "vitest";
import { constantTimeEqual } from "./constantTimeEqual";

describe("constantTimeEqual", () => {
  describe("matching strings", () => {
    it("returns true for identical strings", () => {
      expect(constantTimeEqual("hello", "hello")).toBe(true);
    });

    it("returns true for two empty strings", () => {
      expect(constantTimeEqual("", "")).toBe(true);
    });

    it("returns true for long identical strings", () => {
      const long = "a".repeat(10000);
      expect(constantTimeEqual(long, long)).toBe(true);
    });

    it("returns true for identical strings with special characters", () => {
      const secret = "sk_live_abc123!@#$%^&*()_+-=[]{}|;':\",./<>?";
      expect(constantTimeEqual(secret, secret)).toBe(true);
    });

    it("returns true for single character strings", () => {
      expect(constantTimeEqual("x", "x")).toBe(true);
    });

    it("returns true for strings with unicode characters", () => {
      expect(constantTimeEqual("hello\u00e9", "hello\u00e9")).toBe(true);
    });
  });

  describe("non-matching strings", () => {
    it("returns false for different strings of same length", () => {
      expect(constantTimeEqual("hello", "world")).toBe(false);
    });

    it("returns false for strings differing by one character", () => {
      expect(constantTimeEqual("hello", "hellp")).toBe(false);
    });

    it("returns false for strings differing at the start", () => {
      expect(constantTimeEqual("ahello", "bhello")).toBe(false);
    });

    it("returns false for strings differing only in case", () => {
      expect(constantTimeEqual("Hello", "hello")).toBe(false);
    });

    it("returns false for different lengths", () => {
      expect(constantTimeEqual("short", "a much longer string")).toBe(false);
    });

    it("returns false for empty vs non-empty", () => {
      expect(constantTimeEqual("", "secret")).toBe(false);
    });

    it("returns false for non-empty vs empty", () => {
      expect(constantTimeEqual("secret", "")).toBe(false);
    });

    it("returns false for strings that differ only in length by one", () => {
      expect(constantTimeEqual("abc", "abcd")).toBe(false);
    });

    it("returns false for prefix matches", () => {
      expect(constantTimeEqual("abc", "abcdef")).toBe(false);
    });

    it("returns false for suffix matches", () => {
      expect(constantTimeEqual("def", "abcdef")).toBe(false);
    });
  });

  describe("API key style strings", () => {
    it("returns true for matching API keys", () => {
      const key = "mcp_sk_a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4";
      expect(constantTimeEqual(key, key)).toBe(true);
    });

    it("returns false for API keys differing in last character", () => {
      const key1 = "mcp_sk_a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4";
      const key2 = "mcp_sk_a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d5";
      expect(constantTimeEqual(key1, key2)).toBe(false);
    });
  });

  describe("symmetry", () => {
    it("is symmetric: equal(a, b) === equal(b, a) for matching strings", () => {
      expect(constantTimeEqual("test", "test")).toBe(
        constantTimeEqual("test", "test")
      );
    });

    it("is symmetric: equal(a, b) === equal(b, a) for different lengths", () => {
      expect(constantTimeEqual("short", "longer string")).toBe(
        constantTimeEqual("longer string", "short")
      );
    });

    it("is symmetric: equal(a, b) === equal(b, a) for same length different content", () => {
      expect(constantTimeEqual("aaaa", "bbbb")).toBe(
        constantTimeEqual("bbbb", "aaaa")
      );
    });
  });
});
