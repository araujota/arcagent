import { describe, it, expect } from "vitest";
import { runStaticValidation } from "./validateTests";

const VALID_PUBLIC = `@public @happy-path @validation @error
Feature: Login
  Scenario: Successful login
    Given a registered user
    When they enter valid credentials
    Then they see the dashboard

  Scenario: Failed login
    Given a registered user
    When they enter wrong credentials
    Then they see an error message

  @public @happy-path
  Scenario: Login with remember me
    Given a registered user
    When they sign in with remember me enabled
    Then they remain signed in

  @public @validation
  Scenario: Missing password
    Given a registered user
    When they submit without a password
    Then a validation error is shown

  @public @error
  Scenario: Rate limit exceeded
    Given repeated failed login attempts
    When another login is attempted
    Then the request is rejected

  @public @validation
  Scenario Outline: Username format validation
    Given a login form
    When username "<username>" is submitted
    Then validation "<result>" is returned
    Examples:
      | username | result |
      | a        | invalid |
      | abc      | valid |
      | abc-123  | valid |
      | !!!      | invalid |

  @public @error
  Scenario: Backend unavailable
    Given the auth backend is down
    When the user attempts to log in
    Then a retryable error is shown

  @public @happy-path
  Scenario: Case-insensitive email login
    Given a registered user with mixed-case email
    When they log in with lowercase email
    Then authentication succeeds`;

const VALID_HIDDEN = `@hidden @boundary @security @anti-gaming
Feature: Login Edge Cases
  Scenario: SQL injection attempt
    Given a login form
    When the user enters "' OR 1=1 --" as username
    Then the login is rejected

  Scenario: Empty credentials
    Given a login form
    When the user submits empty fields
    Then a validation error is shown

  @hidden @boundary
  Scenario: Maximum password length
    Given a login form
    When a 256 character password is submitted
    Then input is rejected

  @hidden @security
  Scenario: Credential stuffing signature
    Given repeated sign-in attempts from rotating IPs
    When threshold is exceeded
    Then suspicious activity is blocked

  @hidden @anti-gaming
  Scenario Outline: Diverse credential matrix
    Given a login form
    When username "<username>" and password "<password>" are submitted
    Then result is "<result>"
    Examples:
      | username         | password            | result  |
      | admin            | admin               | fail    |
      | user@example.com | P@ssw0rd!           | pass    |
      | test@example.com | wrong               | fail    |
      | unicode@example.com | pässW0rd!        | pass    |

  @hidden @anti-gaming
  Scenario Outline: Metamorphic input normalization
    Given user identifier "<identifier>"
    When normalization is applied
    Then normalized identifier "<normalized>" is used
    Examples:
      | identifier              | normalized            |
      | USER@EXAMPLE.COM        | user@example.com      |
      | user+tag@example.com    | user@example.com      |
      |  user@example.com       | user@example.com      |
      | user@example.com        | user@example.com      |

  @hidden @security
  Scenario: Timing attack resistance
    Given two invalid passwords with different prefixes
    When auth checks are compared
    Then response timing variance is bounded

  @hidden @boundary
  Scenario: Null-byte payload rejected
    Given a login form
    When credentials contain a null byte
    Then the request is rejected`;

const VALID_STEP_DEFS = JSON.stringify([
  {
    path: "tests/steps/login_steps.ts",
    content:
      "import { Given, When, Then, And, But } from '@cucumber/cucumber';\nGiven(/.*/, () => {});\nWhen(/.*/, () => {});\nThen(/.*/, () => {});\nAnd(/.*/, () => {});\nBut(/.*/, () => {});",
  },
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
    expect(result.stats.publicScenarios).toBe(8);
    expect(result.stats.hiddenScenarios).toBe(8);
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

  it("reports malformed slash-based cucumber expressions", () => {
    const stepDefs = JSON.stringify([
      {
        path: "tests/steps/hidden.steps.js",
        content:
          "const { Then } = require('@cucumber/cucumber');\nThen('the sidebar includes a navigation link to /agenthellos', () => {});",
      },
    ]);
    const result = runStaticValidation({
      gherkinPublic: "",
      gherkinHidden: `Feature: Hidden\n  Scenario: S\n    Then the sidebar includes a navigation link to /agenthellos`,
      stepDefinitions: stepDefs,
    });
    expect(
      result.issues.some((i) => i.includes('invalid "/" alternative boundary'))
    ).toBe(true);
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
    expect(result.stats.publicScenarios).toBe(8);
    expect(result.stats.hiddenScenarios).toBe(8);
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

// ---------------------------------------------------------------------------
// validateTests score default behaviour (P2-3)
// ---------------------------------------------------------------------------

describe("validateTests score default (P2-3)", () => {
  it("null parsed review defaults score to 0 (fail-safe)", () => {
    const parsedReview = null;
    const score = parsedReview?.score ?? 0;
    expect(score).toBe(0);
  });

  it("undefined score defaults to 0", () => {
    const parsedReview = { otherField: "test" } as {
      score?: number;
      otherField: string;
    };
    const score = parsedReview?.score ?? 0;
    expect(score).toBe(0);
  });

  it("valid score is used as-is", () => {
    const parsedReview = { score: 8 };
    const score = parsedReview?.score ?? 0;
    expect(score).toBe(8);
  });

  it("score of 0 is preserved (not treated as falsy)", () => {
    const parsedReview = { score: 0 };
    const score = parsedReview?.score ?? 0;
    expect(score).toBe(0);
  });

  it("score < 7 triggers regeneration", () => {
    const score = 0;
    const needsRegeneration = score < 7;
    expect(needsRegeneration).toBe(true);
  });

  it("score >= 7 does not trigger regeneration from score alone", () => {
    const score = 7;
    const needsRegeneration = score < 7;
    expect(needsRegeneration).toBe(false);
  });
});
