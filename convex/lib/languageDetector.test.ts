import { describe, it, expect } from "vitest";
import {
  detectLanguageFromPath,
  detectRepoLanguages,
  detectLanguageFromManifests,
  detectPackageManager,
  BDD_FRAMEWORK_MAP,
} from "./languageDetector";

// ---------------------------------------------------------------------------
// detectLanguageFromPath
// ---------------------------------------------------------------------------

describe("detectLanguageFromPath", () => {
  const cases: [string, string][] = [
    ["src/index.ts", "typescript"],
    ["components/App.tsx", "typescript"],
    ["src/index.js", "javascript"],
    ["components/App.jsx", "javascript"],
    ["lib/utils.mjs", "javascript"],
    ["lib/utils.cjs", "javascript"],
    ["main.py", "python"],
    ["types.pyi", "python"],
    ["main.go", "go"],
    ["lib.rs", "rust"],
    ["Main.java", "java"],
    ["helper.rb", "ruby"],
    ["App.cs", "csharp"],
    ["Main.kt", "kotlin"],
    ["ContentView.swift", "swift"],
    ["main.cpp", "cpp"],
    ["main.c", "c"],
    ["index.php", "php"],
    ["Build.scala", "scala"],
  ];

  it.each(cases)("detects %s as %s", (path, expected) => {
    expect(detectLanguageFromPath(path)).toBe(expected);
  });

  it("returns 'unknown' for unknown extension", () => {
    expect(detectLanguageFromPath("readme.md")).toBe("unknown");
  });

  it("returns 'unknown' for no extension", () => {
    expect(detectLanguageFromPath("Makefile")).toBe("unknown");
  });

  it("handles nested paths correctly", () => {
    expect(detectLanguageFromPath("src/lib/deep/file.ts")).toBe("typescript");
  });

  it("is case-insensitive for extensions", () => {
    expect(detectLanguageFromPath("file.TS")).toBe("typescript");
    expect(detectLanguageFromPath("file.PY")).toBe("python");
  });
});

// ---------------------------------------------------------------------------
// detectRepoLanguages
// ---------------------------------------------------------------------------

describe("detectRepoLanguages", () => {
  it("detects primary language by count", () => {
    const result = detectRepoLanguages([
      "a.ts",
      "b.ts",
      "c.ts",
      "d.py",
      "e.go",
    ]);
    expect(result.primary).toBe("typescript");
  });

  it("lists all detected languages", () => {
    const result = detectRepoLanguages(["a.ts", "b.py", "c.go"]);
    expect(result.all).toContain("typescript");
    expect(result.all).toContain("python");
    expect(result.all).toContain("go");
  });

  it("returns correct counts", () => {
    const result = detectRepoLanguages(["a.ts", "b.ts", "c.py"]);
    expect(result.counts["typescript"]).toBe(2);
    expect(result.counts["python"]).toBe(1);
  });

  it("returns 'unknown' primary for empty list", () => {
    const result = detectRepoLanguages([]);
    expect(result.primary).toBe("unknown");
    expect(result.all).toEqual([]);
  });

  it("ignores unknown extensions in counts", () => {
    const result = detectRepoLanguages(["a.md", "b.txt", "c.ts"]);
    expect(result.counts["unknown"]).toBeUndefined();
    expect(result.primary).toBe("typescript");
  });
});

// ---------------------------------------------------------------------------
// detectLanguageFromManifests
// ---------------------------------------------------------------------------

describe("detectLanguageFromManifests", () => {
  it("detects TypeScript from tsconfig.json", () => {
    expect(detectLanguageFromManifests(["tsconfig.json", "src/index.ts"])).toBe(
      "typescript"
    );
  });

  it("detects Python from pyproject.toml", () => {
    expect(
      detectLanguageFromManifests(["pyproject.toml", "src/main.py"])
    ).toBe("python");
  });

  it("detects Go from go.mod", () => {
    expect(detectLanguageFromManifests(["go.mod", "main.go"])).toBe("go");
  });

  it("detects Rust from Cargo.toml", () => {
    expect(detectLanguageFromManifests(["Cargo.toml", "src/lib.rs"])).toBe(
      "rust"
    );
  });

  it("detects Java from pom.xml", () => {
    expect(detectLanguageFromManifests(["pom.xml", "src/Main.java"])).toBe(
      "java"
    );
  });

  it("detects Ruby from Gemfile", () => {
    expect(detectLanguageFromManifests(["Gemfile", "app.rb"])).toBe("ruby");
  });

  it("detects PHP from composer.json", () => {
    expect(detectLanguageFromManifests(["composer.json", "index.php"])).toBe(
      "php"
    );
  });

  it("returns null when no manifest files match", () => {
    expect(detectLanguageFromManifests(["README.md", "src/file.txt"])).toBe(
      null
    );
  });

  it("ignores manifest files in subdirectories", () => {
    expect(
      detectLanguageFromManifests(["packages/app/tsconfig.json"])
    ).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// detectPackageManager
// ---------------------------------------------------------------------------

describe("detectPackageManager", () => {
  const cases: [string[], string][] = [
    [["pnpm-lock.yaml", "package.json"], "pnpm"],
    [["yarn.lock", "package.json"], "yarn"],
    [["bun.lockb", "package.json"], "bun"],
    [["package-lock.json", "package.json"], "npm"],
    [["Pipfile.lock", "Pipfile"], "pipenv"],
    [["poetry.lock", "pyproject.toml"], "poetry"],
    [["Cargo.lock", "Cargo.toml"], "cargo"],
    [["go.sum", "go.mod"], "go"],
    [["Gemfile.lock", "Gemfile"], "bundler"],
    [["composer.lock", "composer.json"], "composer"],
  ];

  it.each(cases)("detects %s as %s", (files, expected) => {
    expect(detectPackageManager(files)).toBe(expected);
  });

  it("returns null when no lock files present", () => {
    expect(detectPackageManager(["package.json", "README.md"])).toBe(null);
  });

  it("ignores lock files in subdirectories", () => {
    expect(
      detectPackageManager(["packages/app/package-lock.json"])
    ).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// BDD_FRAMEWORK_MAP
// ---------------------------------------------------------------------------

describe("BDD_FRAMEWORK_MAP", () => {
  const expectedLanguages = [
    "typescript",
    "javascript",
    "python",
    "go",
    "rust",
    "java",
    "ruby",
    "php",
    "csharp",
    "kotlin",
    "c",
    "cpp",
    "swift",
  ];

  it("has entries for all expected languages", () => {
    for (const lang of expectedLanguages) {
      expect(BDD_FRAMEWORK_MAP[lang]).toBeDefined();
    }
  });

  it("Python uses behave (not pytest-bdd)", () => {
    expect(BDD_FRAMEWORK_MAP.python.framework).toBe("behave");
    expect(BDD_FRAMEWORK_MAP.python.runner).toBe("behave");
  });

  it("Node BDD generation aligns with cucumber-js execution", () => {
    expect(BDD_FRAMEWORK_MAP.typescript.runner).toBe("cucumber-js");
    expect(BDD_FRAMEWORK_MAP.javascript.runner).toBe("cucumber-js");
  });

  it("each entry has framework, runner, and configFile", () => {
    for (const lang of expectedLanguages) {
      const entry = BDD_FRAMEWORK_MAP[lang];
      expect(entry).toHaveProperty("framework");
      expect(entry).toHaveProperty("runner");
      expect(entry).toHaveProperty("configFile");
      expect(typeof entry.framework).toBe("string");
      expect(typeof entry.runner).toBe("string");
      expect(typeof entry.configFile).toBe("string");
    }
  });
});
