import { describe, it, expect } from "vitest";
import {
  parseJsonSafe,
  parseNdjson,
  parseCommandOutput,
  extractMetrics,
} from "./resultParser";

// ---------------------------------------------------------------------------
// parseJsonSafe
// ---------------------------------------------------------------------------

describe("parseJsonSafe", () => {
  it("returns null for empty string", () => {
    expect(parseJsonSafe("")).toBeNull();
  });

  it("returns null for whitespace-only string", () => {
    expect(parseJsonSafe("   \n\t  ")).toBeNull();
  });

  it("parses valid JSON directly (fast path)", () => {
    expect(parseJsonSafe('{"key":"val"}')).toEqual({ key: "val" });
  });

  it("parses a JSON array directly", () => {
    expect(parseJsonSafe("[1,2,3]")).toEqual([1, 2, 3]);
  });

  it("extracts JSON from string with non-JSON preamble", () => {
    const raw = 'Loading modules...\nInitializing...\n{"status":"ok"}';
    expect(parseJsonSafe(raw)).toEqual({ status: "ok" });
  });

  it("handles nested JSON with balanced braces via extractJson", () => {
    const raw = 'prefix {"outer":{"inner":"value"}} suffix';
    expect(parseJsonSafe(raw)).toEqual({ outer: { inner: "value" } });
  });

  it("handles strings containing braces inside quoted values (no false match)", () => {
    const json = '{"msg":"hello {world}"}';
    expect(parseJsonSafe(json)).toEqual({ msg: "hello {world}" });
  });

  it("returns null for genuinely invalid JSON (no { or [)", () => {
    expect(parseJsonSafe("just some plain text")).toBeNull();
  });

  it("returns null for unbalanced braces", () => {
    expect(parseJsonSafe("prefix {broken")).toBeNull();
  });

  it("handles escaped quotes inside JSON strings", () => {
    const raw = 'noise {"key":"val\\"ue"} more';
    expect(parseJsonSafe(raw)).toEqual({ key: 'val"ue' });
  });
});

// ---------------------------------------------------------------------------
// parseNdjson
// ---------------------------------------------------------------------------

describe("parseNdjson", () => {
  it("returns empty array for empty input", () => {
    expect(parseNdjson("")).toEqual([]);
  });

  it("returns empty array for whitespace-only input", () => {
    expect(parseNdjson("  \n  ")).toEqual([]);
  });

  it("parses multiple JSON lines", () => {
    const raw = '{"a":1}\n{"b":2}\n{"c":3}';
    expect(parseNdjson(raw)).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  it("skips non-JSON lines", () => {
    const raw = 'Loading...\n{"a":1}\nDone.\n{"b":2}';
    expect(parseNdjson(raw)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("skips lines that don't start with { or [", () => {
    const raw = 'key: value\n{"valid":true}\ntrue';
    expect(parseNdjson(raw)).toEqual([{ valid: true }]);
  });

  it("parses array lines starting with [", () => {
    const raw = '[1,2]\n[3,4]';
    expect(parseNdjson(raw)).toEqual([[1, 2], [3, 4]]);
  });

  it("skips lines that start with { but are invalid JSON", () => {
    const raw = '{broken\n{"ok":true}';
    expect(parseNdjson(raw)).toEqual([{ ok: true }]);
  });
});

// ---------------------------------------------------------------------------
// parseCommandOutput
// ---------------------------------------------------------------------------

describe("parseCommandOutput", () => {
  it("returns undefined for empty input", () => {
    expect(parseCommandOutput("")).toBeUndefined();
  });

  it("returns undefined for whitespace-only input", () => {
    expect(parseCommandOutput("   ")).toBeUndefined();
  });

  it("prefers JSON parsing (calls parseJsonSafe first)", () => {
    const output = '{"errors": 0, "warnings": 2}';
    expect(parseCommandOutput(output)).toEqual({ errors: 0, warnings: 2 });
  });

  it("falls back to key: value parsing", () => {
    const output = "errors: 5\nwarnings: 3\nstatus: ok";
    const result = parseCommandOutput(output);
    expect(result).toEqual({
      errors: "5",
      warnings: "3",
      status: "ok",
    });
  });

  it("falls back to key=value parsing", () => {
    const output = "count=10\nname=test";
    const result = parseCommandOutput(output);
    expect(result).toEqual({ count: "10", name: "test" });
  });

  it("returns undefined when no key-value pairs found", () => {
    expect(parseCommandOutput("just random text\nno structure here")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// extractMetrics
// ---------------------------------------------------------------------------

describe("extractMetrics", () => {
  it("extracts numeric value matching regex capture group", () => {
    const output = "Total: 42 issues found\nCoverage: 85.5%";
    const patterns = {
      total: /Total:\s*(\d+)/,
      coverage: /Coverage:\s*([\d.]+)/,
    };
    expect(extractMetrics(output, patterns)).toEqual({
      total: 42,
      coverage: 85.5,
    });
  });

  it("returns empty object when no patterns match", () => {
    const output = "nothing relevant here";
    const patterns = { total: /Total:\s*(\d+)/ };
    expect(extractMetrics(output, patterns)).toEqual({});
  });

  it("skips patterns where capture group is not a number", () => {
    const output = "Total: abc";
    const patterns = { total: /Total:\s*(\w+)/ };
    expect(extractMetrics(output, patterns)).toEqual({});
  });

  it("handles multiple patterns with partial matches", () => {
    const output = "errors: 3\nno coverage data";
    const patterns = {
      errors: /errors:\s*(\d+)/,
      coverage: /coverage:\s*([\d.]+)/,
    };
    expect(extractMetrics(output, patterns)).toEqual({ errors: 3 });
  });
});
