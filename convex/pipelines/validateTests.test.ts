import { describe, it, expect } from "vitest";
import { runStaticValidation } from "./validateTests";

const VALID_PUBLIC = `Feature: Login
  Scenario: Successful login
    Given a registered user
    When they enter valid credentials
    Then they see the dashboard

  Scenario: Failed login
    Given a registered user
    When they enter wrong credentials
    Then they see an error message`;

const VALID_HIDDEN = `Feature: Login Edge Cases
  Scenario: SQL injection attempt
    Given a login form
    When the user enters "' OR 1=1 --" as username
    Then the login is rejected

  Scenario: Empty credentials
    Given a login form
    When the user submits empty fields
    Then a validation error is shown`;

const VALID_STEP_DEFS = JSON.stringify([
  { path: "tests/steps/login_steps.ts", content: "import { Given } from '@cucumber/cucumber';\nGiven('a registered user', () => {});" },
  { path: "tests/support/world.ts", content: "export class World { user: any; }" },
]);

// ---------------------------------------------------------------------------
// runStaticValidation
// ---------------------------------------------------------------------------

describe("runStaticValidation", () => {
  it("returns no issues for valid public + hidden gherkin", () => {
    const result = runStaticValidation({
      gherkinPublic: VALID_PUBLIC,
      gherkinHidden: VALID_HIDDEN,
      stepDefinitions: VALID_STEP_DEFS,
    });
    expect(result.issues).toHaveLength(0);
    expect(result.stats.publicScenarios).toBe(2);
    expect(result.stats.hiddenScenarios).toBe(2);
  });

  it("reports errors for invalid public gherkin", () => {
    const result = runStaticValidation({
      gherkinPublic: "Feature: Bad\n  Scenario: No steps",
      gherkinHidden: VALID_HIDDEN,
      stepDefinitions: VALID_STEP_DEFS,
    });
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues.some((i) => i.includes("Public Gherkin"))).toBe(true);
  });

  it("reports errors for invalid hidden gherkin", () => {
    const result = runStaticValidation({
      gherkinPublic: VALID_PUBLIC,
      gherkinHidden: "Feature: Bad\n  Scenario: No steps",
      stepDefinitions: VALID_STEP_DEFS,
    });
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues.some((i) => i.includes("Hidden Gherkin"))).toBe(true);
  });

  it("collects warnings from gherkin validation", () => {
    const gherkinWithWarning = `@weird!tag
Feature: Test
  Scenario: S1
    Given a
    When b
    Then c`;
    const result = runStaticValidation({
      gherkinPublic: gherkinWithWarning,
      gherkinHidden: VALID_HIDDEN,
      stepDefinitions: VALID_STEP_DEFS,
    });
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("reports issue when zero scenarios exist", () => {
    const result = runStaticValidation({
      gherkinPublic: "",
      gherkinHidden: "",
      stepDefinitions: VALID_STEP_DEFS,
    });
    expect(result.issues.some((i) => i.includes("No scenarios found"))).toBe(
      true
    );
  });

  it("reports issue for empty step definitions string", () => {
    const result = runStaticValidation({
      gherkinPublic: VALID_PUBLIC,
      gherkinHidden: VALID_HIDDEN,
      stepDefinitions: "",
    });
    expect(
      result.issues.some((i) => i.includes("No step definitions generated"))
    ).toBe(true);
  });

  it("reports issue for JSON step defs with empty file content", () => {
    const stepDefs = JSON.stringify([
      { path: "test.ts", content: "" },
    ]);
    const result = runStaticValidation({
      gherkinPublic: VALID_PUBLIC,
      gherkinHidden: VALID_HIDDEN,
      stepDefinitions: stepDefs,
    });
    expect(result.issues.some((i) => i.includes("is empty"))).toBe(true);
  });

  it("reports no issues for valid JSON step defs with content", () => {
    const result = runStaticValidation({
      gherkinPublic: VALID_PUBLIC,
      gherkinHidden: VALID_HIDDEN,
      stepDefinitions: VALID_STEP_DEFS,
    });
    expect(
      result.issues.filter((i) => i.includes("step definition")).length
    ).toBe(0);
  });

  it("returns correct scenario count stats", () => {
    const result = runStaticValidation({
      gherkinPublic: VALID_PUBLIC,
      gherkinHidden: VALID_HIDDEN,
      stepDefinitions: VALID_STEP_DEFS,
    });
    expect(result.stats.publicScenarios).toBe(2);
    expect(result.stats.hiddenScenarios).toBe(2);
    expect(result.stats.stepDefFiles).toBe(2);
  });

  it("handles non-JSON step definitions without error", () => {
    const result = runStaticValidation({
      gherkinPublic: VALID_PUBLIC,
      gherkinHidden: VALID_HIDDEN,
      stepDefinitions: "import { Given } from '@cucumber/cucumber';",
    });
    // Should not crash, no "No step definitions generated" since string isn't empty
    expect(
      result.issues.some((i) => i.includes("No step definitions"))
    ).toBe(false);
  });
});
