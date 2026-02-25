import { describe, it, expect } from "vitest";
import { assessBddQuality, buildBDDSystemPrompt, parseBDDResponse } from "./generateBDD";

// ---------------------------------------------------------------------------
// parseBDDResponse
// ---------------------------------------------------------------------------

describe("parseBDDResponse", () => {
  it("parses valid JSON with public/hidden fields", () => {
    const response = JSON.stringify({
      analysis: { actors: ["user"], inputs: ["email"] },
      public: "Feature: Login\n  Scenario: OK\n    Given a\n    When b\n    Then c",
      hidden: "Feature: Login Hidden\n  Scenario: Edge\n    Given x\n    When y\n    Then z",
    });
    const result = parseBDDResponse(response);
    expect(result.public).toContain("Feature: Login");
    expect(result.hidden).toContain("Feature: Login Hidden");
    expect(result.analysis?.actors).toContain("user");
  });

  it("parses fenced JSON (```json ... ```)", () => {
    const response = `\`\`\`json
{"public": "Feature: A\\n  Scenario: B\\n    Given c\\n    When d\\n    Then e", "hidden": "Feature: F\\n  Scenario: G\\n    Given h\\n    When i\\n    Then j"}
\`\`\``;
    const result = parseBDDResponse(response);
    expect(result.public).toContain("Feature: A");
    expect(result.hidden).toContain("Feature: F");
  });

  it("falls back to delimiter split when JSON fails", () => {
    const response = `Feature: Public stuff
  Scenario: A
    Given x
    When y
    Then z

--- HIDDEN ---

Feature: Hidden stuff
  Scenario: B
    Given a
    When b
    Then c`;
    const result = parseBDDResponse(response);
    expect(result.public).toContain("Feature: Public stuff");
    expect(result.hidden).toContain("Feature: Hidden stuff");
  });

  it("handles case-insensitive delimiter", () => {
    const response = `public content\n--- hidden ---\nhidden content`;
    const result = parseBDDResponse(response);
    expect(result.public).toBe("public content");
    expect(result.hidden).toBe("hidden content");
  });

  it("strips gherkin fences from delimiter fallback", () => {
    const response = `\`\`\`gherkin
Feature: Public
  Scenario: A
    Given a
    When b
    Then c\`\`\`

--- HIDDEN ---

\`\`\`gherkin
Feature: Hidden
  Scenario: B
    Given d
    When e
    Then f\`\`\``;
    const result = parseBDDResponse(response);
    expect(result.public).toContain("Feature: Public");
    expect(result.hidden).toContain("Feature: Hidden");
  });

  it("returns full response as public when no delimiter found", () => {
    const response = "Feature: Something\n  Scenario: A\n    Given x\n    When y\n    Then z";
    const result = parseBDDResponse(response);
    expect(result.public).toContain("Feature: Something");
    expect(result.hidden).toBe("");
  });

  it("handles empty fields in JSON", () => {
    const response = JSON.stringify({ public: "", hidden: "" });
    const result = parseBDDResponse(response);
    expect(result.public).toBe("");
    expect(result.hidden).toBe("");
  });

  it("handles missing keys in JSON gracefully", () => {
    const response = JSON.stringify({ analysis: { actors: ["admin"] } });
    const result = parseBDDResponse(response);
    expect(result.public).toBe("");
    expect(result.hidden).toBe("");
    expect(result.analysis?.actors).toContain("admin");
  });
});

// ---------------------------------------------------------------------------
// buildBDDSystemPrompt
// ---------------------------------------------------------------------------

describe("buildBDDSystemPrompt", () => {
  it("always includes the description", () => {
    const prompt = buildBDDSystemPrompt({
      description: "Build a REST API for user management",
    });
    expect(prompt).toContain("Build a REST API for user management");
    expect(prompt).toContain("Feature Request");
  });

  it("includes repo context section when provided", () => {
    const prompt = buildBDDSystemPrompt({
      description: "test",
      repoMapText: "src/\n  index.ts\n  lib/",
    });
    expect(prompt).toContain("## Repository Structure");
    expect(prompt).toContain("src/");
  });

  it("omits repo context section when absent", () => {
    const prompt = buildBDDSystemPrompt({ description: "test" });
    expect(prompt).not.toContain("## Repository Structure");
  });

  it("includes existing gherkin section when provided", () => {
    const prompt = buildBDDSystemPrompt({
      description: "test",
      existingGherkin: "Feature: Existing\n  Scenario: Old",
    });
    expect(prompt).toContain("Existing Test Scenarios");
    expect(prompt).toContain("Do NOT duplicate");
  });

  it("includes conversation history when provided", () => {
    const prompt = buildBDDSystemPrompt({
      description: "test",
      conversationHistory: "user: The API should return JSON",
    });
    expect(prompt).toContain("Clarification Answers");
    expect(prompt).toContain("The API should return JSON");
  });

  it("includes extracted criteria when provided", () => {
    const prompt = buildBDDSystemPrompt({
      description: "test",
      extractedCriteria: ["Must validate email", "Must return 201 on create"],
    });
    expect(prompt).toContain("Extracted Acceptance Criteria");
    expect(prompt).toContain("Must validate email");
    expect(prompt).toContain("Must return 201 on create");
  });

  it("includes feature exemplar section when provided", () => {
    const prompt = buildBDDSystemPrompt({
      description: "test",
      existingFeatureExemplars: "# features/login.feature\nFeature: Login",
    });
    expect(prompt).toContain("Style Reference");
    expect(prompt).toContain("features/login.feature");
  });

  it("includes 3-phase chain-of-thought instructions", () => {
    const prompt = buildBDDSystemPrompt({ description: "test" });
    expect(prompt).toContain("Phase 1");
    expect(prompt).toContain("Phase 2");
    expect(prompt).toContain("Phase 3");
    expect(prompt).toContain("ANTI-GAMING");
    expect(prompt).toContain("BOUNDARY VALUES");
  });
});

describe("assessBddQuality", () => {
  it("flags invalid/undersized suites", () => {
    const result = assessBddQuality(
      "Feature: Short\n  Scenario: One\n    Given a\n    When b\n    Then c",
      "Feature: Hidden\n  Scenario: One\n    Given a\n    When b\n    Then c",
    );
    expect(result.qualityIssues.length).toBeGreaterThan(0);
    expect(result.publicScenarioCount).toBe(1);
    expect(result.hiddenScenarioCount).toBe(1);
  });

  it("passes when both suites meet baseline counts and syntax", () => {
    const publicGherkin = `Feature: Public
  Scenario: One
    Given a
    When b
    Then c
  Scenario: Two
    Given a
    When b
    Then c
  Scenario: Three
    Given a
    When b
    Then c
  Scenario: Four
    Given a
    When b
    Then c
  Scenario: Five
    Given a
    When b
    Then c
  Scenario: Six
    Given a
    When b
    Then c
  Scenario: Seven
    Given a
    When b
    Then c
  Scenario: Eight
    Given a
    When b
    Then c`;
    const hiddenGherkin = publicGherkin.replace("Feature: Public", "Feature: Hidden");
    const result = assessBddQuality(publicGherkin, hiddenGherkin);
    expect(result.qualityIssues).toHaveLength(0);
  });
});
