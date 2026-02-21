import { describe, it, expect } from "vitest";
import { filterToChangedFiles, filterToChangedLines } from "./diffFilter";

// ---------------------------------------------------------------------------
// Types for test diagnostics
// ---------------------------------------------------------------------------

interface TestDiagnostic {
  path?: string;
  line?: number;
  message: string;
}

const getPath = (d: TestDiagnostic) => d.path;
const getLine = (d: TestDiagnostic) => d.line;

// ---------------------------------------------------------------------------
// filterToChangedFiles
// ---------------------------------------------------------------------------

describe("filterToChangedFiles", () => {
  it("filters diagnostics to only those in changed files", () => {
    const diagnostics: TestDiagnostic[] = [
      { path: "src/a.ts", message: "error in a" },
      { path: "src/b.ts", message: "error in b" },
      { path: "src/c.ts", message: "error in c" },
    ];
    const result = filterToChangedFiles(diagnostics, getPath, ["src/a.ts", "src/c.ts"]);
    expect(result).toEqual([
      { path: "src/a.ts", message: "error in a" },
      { path: "src/c.ts", message: "error in c" },
    ]);
  });

  it("normalizes /workspace/ prefix (VM path vs relative)", () => {
    const diagnostics: TestDiagnostic[] = [
      { path: "/workspace/src/index.ts", message: "error" },
    ];
    const result = filterToChangedFiles(diagnostics, getPath, ["src/index.ts"]);
    expect(result).toHaveLength(1);
  });

  it("normalizes ./ prefix", () => {
    const diagnostics: TestDiagnostic[] = [
      { path: "./src/index.ts", message: "error" },
    ];
    const result = filterToChangedFiles(diagnostics, getPath, ["src/index.ts"]);
    expect(result).toHaveLength(1);
  });

  it("returns empty array when no matches", () => {
    const diagnostics: TestDiagnostic[] = [
      { path: "src/other.ts", message: "error" },
    ];
    const result = filterToChangedFiles(diagnostics, getPath, ["src/changed.ts"]);
    expect(result).toEqual([]);
  });

  it("excludes diagnostics where getPath returns undefined", () => {
    const diagnostics: TestDiagnostic[] = [
      { message: "no path" },
      { path: "src/a.ts", message: "has path" },
    ];
    const result = filterToChangedFiles(diagnostics, getPath, ["src/a.ts"]);
    expect(result).toHaveLength(1);
    expect(result[0]!.message).toBe("has path");
  });

  it("matches /workspace/ prefix in changed files to plain diagnostic paths", () => {
    const diagnostics: TestDiagnostic[] = [
      { path: "src/index.ts", message: "error" },
    ];
    const result = filterToChangedFiles(diagnostics, getPath, ["/workspace/src/index.ts"]);
    expect(result).toHaveLength(1);
  });

  it("handles empty diagnostics array", () => {
    const result = filterToChangedFiles([], getPath, ["src/a.ts"]);
    expect(result).toEqual([]);
  });

  it("handles empty changed files list", () => {
    const diagnostics: TestDiagnostic[] = [
      { path: "src/a.ts", message: "error" },
    ];
    const result = filterToChangedFiles(diagnostics, getPath, []);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// filterToChangedLines
// ---------------------------------------------------------------------------

describe("filterToChangedLines", () => {
  it("includes diagnostic at line within a changed range", () => {
    const diagnostics: TestDiagnostic[] = [
      { path: "src/a.ts", line: 15, message: "error at line 15" },
    ];
    const ranges = new Map([["src/a.ts", [[10, 20]] as [number, number][]]]);
    const result = filterToChangedLines(diagnostics, getPath, getLine, ranges);
    expect(result).toHaveLength(1);
  });

  it("excludes diagnostic at line outside changed ranges", () => {
    const diagnostics: TestDiagnostic[] = [
      { path: "src/a.ts", line: 50, message: "error at line 50" },
    ];
    const ranges = new Map([["src/a.ts", [[10, 20]] as [number, number][]]]);
    const result = filterToChangedLines(diagnostics, getPath, getLine, ranges);
    expect(result).toEqual([]);
  });

  it("handles multiple ranges per file", () => {
    const diagnostics: TestDiagnostic[] = [
      { path: "src/a.ts", line: 5, message: "in range 1" },
      { path: "src/a.ts", line: 25, message: "in range 2" },
      { path: "src/a.ts", line: 15, message: "between ranges" },
    ];
    const ranges = new Map([
      ["src/a.ts", [[1, 10], [20, 30]] as [number, number][]],
    ]);
    const result = filterToChangedLines(diagnostics, getPath, getLine, ranges);
    expect(result).toHaveLength(2);
    expect(result.map((d) => d.message)).toEqual(["in range 1", "in range 2"]);
  });

  it("normalizes path comparison across /workspace/ prefix", () => {
    const diagnostics: TestDiagnostic[] = [
      { path: "/workspace/src/a.ts", line: 5, message: "error" },
    ];
    const ranges = new Map([["src/a.ts", [[1, 10]] as [number, number][]]]);
    const result = filterToChangedLines(diagnostics, getPath, getLine, ranges);
    expect(result).toHaveLength(1);
  });

  it("returns empty when getLine returns undefined", () => {
    const diagnostics: TestDiagnostic[] = [
      { path: "src/a.ts", message: "no line" },
    ];
    const ranges = new Map([["src/a.ts", [[1, 100]] as [number, number][]]]);
    const result = filterToChangedLines(diagnostics, getPath, getLine, ranges);
    expect(result).toEqual([]);
  });

  it("includes diagnostic at exact boundary of range", () => {
    const diagnostics: TestDiagnostic[] = [
      { path: "src/a.ts", line: 10, message: "at start" },
      { path: "src/a.ts", line: 20, message: "at end" },
    ];
    const ranges = new Map([["src/a.ts", [[10, 20]] as [number, number][]]]);
    const result = filterToChangedLines(diagnostics, getPath, getLine, ranges);
    expect(result).toHaveLength(2);
  });

  it("excludes diagnostic for file not in ranges", () => {
    const diagnostics: TestDiagnostic[] = [
      { path: "src/b.ts", line: 5, message: "wrong file" },
    ];
    const ranges = new Map([["src/a.ts", [[1, 100]] as [number, number][]]]);
    const result = filterToChangedLines(diagnostics, getPath, getLine, ranges);
    expect(result).toEqual([]);
  });
});
