import { describe, it, expect, vi } from "vitest";
import { detectLanguageFromFiles } from "./languageDetector";

// Mock the logger imported from index.ts
vi.mock("../index", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// detectLanguageFromFiles
// ---------------------------------------------------------------------------

describe("detectLanguageFromFiles", () => {
  it('tsconfig.json + package.json -> "typescript"', () => {
    expect(detectLanguageFromFiles(["tsconfig.json", "package.json"])).toBe("typescript");
  });

  it('package.json alone -> "javascript"', () => {
    expect(detectLanguageFromFiles(["package.json"])).toBe("javascript");
  });

  it('Cargo.toml -> "rust"', () => {
    expect(detectLanguageFromFiles(["Cargo.toml", "src/main.rs"])).toBe("rust");
  });

  it('go.mod -> "go"', () => {
    expect(detectLanguageFromFiles(["go.mod", "go.sum", "main.go"])).toBe("go");
  });

  it('pyproject.toml -> "python"', () => {
    expect(detectLanguageFromFiles(["pyproject.toml", "src/main.py"])).toBe("python");
  });

  it('pom.xml -> "java"', () => {
    expect(detectLanguageFromFiles(["pom.xml", "src/Main.java"])).toBe("java");
  });

  it('Gemfile -> "ruby"', () => {
    expect(detectLanguageFromFiles(["Gemfile", "Gemfile.lock"])).toBe("ruby");
  });

  it('composer.json -> "php"', () => {
    expect(detectLanguageFromFiles(["composer.json"])).toBe("php");
  });

  it('Package.swift -> "swift"', () => {
    expect(detectLanguageFromFiles(["Package.swift"])).toBe("swift");
  });

  it('extension-based: .csproj -> "csharp"', () => {
    expect(detectLanguageFromFiles(["MyProject.csproj", "Program.cs"])).toBe("csharp");
  });

  it('extension-based: .sln -> "csharp"', () => {
    expect(detectLanguageFromFiles(["Solution.sln"])).toBe("csharp");
  });

  it('no matching indicators -> "unknown"', () => {
    expect(detectLanguageFromFiles(["README.md", "LICENSE"])).toBe("unknown");
  });

  it("typescript wins over javascript when both present (higher weight)", () => {
    expect(detectLanguageFromFiles(["tsconfig.json", "package.json", "yarn.lock"])).toBe("typescript");
  });

  it("handles empty file list", () => {
    expect(detectLanguageFromFiles([])).toBe("unknown");
  });
});
