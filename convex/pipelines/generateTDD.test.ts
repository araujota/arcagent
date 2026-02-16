import { describe, it, expect } from "vitest";
import { getExtension, buildTDDPrompt, parseTDDResponse } from "./generateTDD";

// ---------------------------------------------------------------------------
// parseTDDResponse
// ---------------------------------------------------------------------------

describe("parseTDDResponse", () => {
  it("parses valid JSON with files array", () => {
    const response = JSON.stringify({
      files: [
        { path: "tests/steps/login.ts", content: "import { Given } from '...';" },
        { path: "tests/support/world.ts", content: "export class World {}" },
      ],
      framework: "cucumber-js",
      runCommand: "npx cucumber-js",
    });
    const result = parseTDDResponse(response, "fallback-framework");
    const parsed = JSON.parse(result.stepDefs);
    expect(parsed).toHaveLength(2);
    expect(result.framework).toBe("cucumber-js");
  });

  it("parses fenced JSON (```json ... ```)", () => {
    const response = `\`\`\`json
{
  "files": [{"path": "test.ts", "content": "code"}],
  "framework": "vitest"
}
\`\`\``;
    const result = parseTDDResponse(response, "default");
    const parsed = JSON.parse(result.stepDefs);
    expect(parsed).toHaveLength(1);
    expect(result.framework).toBe("vitest");
  });

  it("falls back to raw response when JSON parsing fails", () => {
    const response = "import { Given } from '@cucumber/cucumber';\n\nGiven('something', () => {});";
    const result = parseTDDResponse(response, "cucumber-js");
    expect(result.stepDefs).toBe(response);
    expect(result.framework).toBe("cucumber-js");
  });

  it("uses default framework when JSON has no framework field", () => {
    const response = JSON.stringify({ files: [] });
    const result = parseTDDResponse(response, "my-default");
    expect(result.framework).toBe("my-default");
  });

  it("handles empty files array", () => {
    const response = JSON.stringify({ files: [], framework: "jest" });
    const result = parseTDDResponse(response, "fallback");
    expect(JSON.parse(result.stepDefs)).toEqual([]);
    expect(result.framework).toBe("jest");
  });
});

// ---------------------------------------------------------------------------
// getExtension
// ---------------------------------------------------------------------------

describe("getExtension", () => {
  const cases: [string, string][] = [
    ["typescript", "ts"],
    ["javascript", "js"],
    ["python", "py"],
    ["go", "go"],
    ["rust", "rs"],
    ["java", "java"],
    ["ruby", "rb"],
    ["php", "php"],
    ["csharp", "cs"],
    ["kotlin", "kt"],
    ["c", "c"],
    ["cpp", "cpp"],
    ["swift", "swift"],
  ];

  it.each(cases)("maps %s to .%s", (lang, ext) => {
    expect(getExtension(lang)).toBe(ext);
  });

  it("returns 'ts' for unknown language", () => {
    expect(getExtension("brainfuck")).toBe("ts");
  });
});

// ---------------------------------------------------------------------------
// buildTDDPrompt
// ---------------------------------------------------------------------------

describe("buildTDDPrompt", () => {
  const baseArgs = {
    gherkin: "Feature: Test\n  Scenario: S1\n    Given a\n    When b\n    Then c",
    label: "public",
    framework: "cucumber-js",
    language: "typescript",
    runner: "vitest",
    configFile: "cucumber.js",
  };

  it("includes framework and language in the prompt", () => {
    const prompt = buildTDDPrompt(baseArgs);
    expect(prompt).toContain("cucumber-js");
    expect(prompt).toContain("typescript");
    expect(prompt).toContain("vitest");
  });

  it("includes gherkin with label", () => {
    const prompt = buildTDDPrompt(baseArgs);
    expect(prompt).toContain("Gherkin Features (public):");
    expect(prompt).toContain("Feature: Test");
  });

  it("includes repo context when provided", () => {
    const prompt = buildTDDPrompt({
      ...baseArgs,
      repoMapText: "src/\n  index.ts",
    });
    expect(prompt).toContain("## Repository Structure:");
    expect(prompt).toContain("src/");
  });

  it("omits repo context when absent", () => {
    const prompt = buildTDDPrompt(baseArgs);
    expect(prompt).not.toContain("## Repository Structure:");
  });

  it("includes existing test exemplars when provided", () => {
    const prompt = buildTDDPrompt({
      ...baseArgs,
      existingTestExemplars: "### src/lib.test.ts\nimport { test } from 'vitest';",
    });
    expect(prompt).toContain("Existing Test Code Style");
    expect(prompt).toContain("src/lib.test.ts");
  });

  it("includes completeness instruction", () => {
    const prompt = buildTDDPrompt(baseArgs);
    expect(prompt).toContain("CRITICAL: Every Given, When, Then");
    expect(prompt).toContain("mentally verify that no steps");
  });

  it("uses correct file extension in output template", () => {
    const prompt = buildTDDPrompt({ ...baseArgs, language: "python" });
    expect(prompt).toContain("feature_steps.py");
    expect(prompt).toContain("world.py");
  });
});
