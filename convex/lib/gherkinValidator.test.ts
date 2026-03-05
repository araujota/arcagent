import { describe, it, expect } from "vitest";
import {
  validateGherkin,
  extractScenarioNames,
  extractFeatureNames,
  countStepsByType,
} from "./gherkinValidator";

// ---------------------------------------------------------------------------
// validateGherkin — valid features
// ---------------------------------------------------------------------------

describe("validateGherkin — valid features", () => {
  it("accepts a minimal valid feature (Feature + Scenario + G/W/T)", () => {
    const result = validateGherkin(
      `Feature: Login
  Scenario: Successful login
    Given a registered user
    When they enter valid credentials
    Then they see the dashboard`
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.stats.features).toBe(1);
    expect(result.stats.scenarios).toBe(1);
  });

  it("accepts multiple scenarios in one feature", () => {
    const result = validateGherkin(
      `Feature: Login
  Scenario: Successful login
    Given a registered user
    When they enter valid credentials
    Then they see the dashboard

  Scenario: Failed login
    Given a registered user
    When they enter wrong credentials
    Then they see an error`
    );
    expect(result.valid).toBe(true);
    expect(result.stats.scenarios).toBe(2);
  });

  it("accepts a Feature with Background", () => {
    const result = validateGherkin(
      `Feature: Shopping cart
  Background:
    Given the store has items in stock

  Scenario: Add item
    Given I am on the store page
    When I click add to cart
    Then the cart has 1 item`
    );
    expect(result.valid).toBe(true);
    expect(result.stats.scenarios).toBe(1);
  });

  it("accepts Scenario Outline with Examples table", () => {
    const result = validateGherkin(
      `Feature: Calculator
  Scenario Outline: Addition
    Given I have entered <a> into the calculator
    When I press add
    And I enter <b>
    Then the result should be <c>

    Examples:
      | a | b | c |
      | 1 | 2 | 3 |
      | 5 | 5 | 10 |`
    );
    expect(result.valid).toBe(true);
    expect(result.stats.scenarios).toBe(1);
  });

  it("accepts doc strings (triple-quote blocks)", () => {
    const result = validateGherkin(
      `Feature: API
  Scenario: POST request
    Given the API is running
    When I send a POST with body
      """
      {"name": "test"}
      """
    Then the response is 201`
    );
    expect(result.valid).toBe(true);
  });

  it("accepts data tables (pipe rows)", () => {
    const result = validateGherkin(
      `Feature: Users
  Scenario: List users
    Given the following users exist:
      | name  | email       |
      | Alice | a@test.com  |
      | Bob   | b@test.com  |
    When I request the user list
    Then I see 2 users`
    );
    expect(result.valid).toBe(true);
  });

  it("accepts tags (@smoke @happy-path)", () => {
    const result = validateGherkin(
      `@smoke @happy-path
Feature: Login
  @critical
  Scenario: Successful login
    Given a user
    When they log in
    Then it works`
    );
    expect(result.valid).toBe(true);
    expect(result.stats.tags).toContain("@smoke");
    expect(result.stats.tags).toContain("@happy-path");
    expect(result.stats.tags).toContain("@critical");
  });

  it("accepts And/But after Given/When/Then", () => {
    const result = validateGherkin(
      `Feature: Checkout
  Scenario: Apply discount
    Given a cart with items
    And a valid coupon
    When I apply the coupon
    But the cart total is below minimum
    Then I see a warning`
    );
    expect(result.valid).toBe(true);
    expect(result.stats.steps).toBe(5);
  });

  it("accepts description text after Feature: line", () => {
    const result = validateGherkin(
      `Feature: User registration
  As a new user
  I want to create an account
  So that I can access the platform

  Scenario: Register with email
    Given I am on the registration page
    When I fill in my details
    Then my account is created`
    );
    expect(result.valid).toBe(true);
  });

  it("ignores comments (# lines)", () => {
    const result = validateGherkin(
      `# This is a comment
Feature: Test
  # Another comment
  Scenario: Example
    Given something
    # Inline comment
    When action
    Then result`
    );
    expect(result.valid).toBe(true);
  });

  it("ignores empty lines between steps", () => {
    const result = validateGherkin(
      `Feature: Test

  Scenario: Example

    Given something

    When action

    Then result`
    );
    expect(result.valid).toBe(true);
  });

  it("accepts multiple features in one file", () => {
    const result = validateGherkin(
      `Feature: Feature A
  Scenario: Scenario A1
    Given a
    When b
    Then c

Feature: Feature B
  Scenario: Scenario B1
    Given d
    When e
    Then f`
    );
    expect(result.valid).toBe(true);
    expect(result.stats.features).toBe(2);
    expect(result.stats.scenarios).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// validateGherkin — invalid features
// ---------------------------------------------------------------------------

describe("validateGherkin — invalid features", () => {
  it("rejects empty content → 'No Feature found'", () => {
    const result = validateGherkin("");
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain("No Feature found");
  });

  it("rejects Feature with no scenarios", () => {
    const result = validateGherkin("Feature: Empty feature");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("no Scenarios"))).toBe(
      true
    );
  });

  it("rejects Scenario with no steps", () => {
    const result = validateGherkin(
      `Feature: Test
  Scenario: No steps`
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes("no steps"))).toBe(
      true
    );
  });

  it("rejects Scenario outside Feature", () => {
    const result = validateGherkin(
      `Scenario: Orphan
    Given a
    When b
    Then c`
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.message.includes("must be inside a Feature"))
    ).toBe(true);
  });

  it("rejects Background outside Feature", () => {
    const result = validateGherkin(
      `Background:
    Given a`
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.message.includes("must be inside a Feature"))
    ).toBe(true);
  });

  it("rejects orphaned And (no preceding step)", () => {
    const result = validateGherkin(
      `Feature: Test
  Scenario: Bad
    And orphan step`
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.message.includes("must follow"))
    ).toBe(true);
  });

  it("rejects orphaned But (no preceding step)", () => {
    const result = validateGherkin(
      `Feature: Test
  Scenario: Bad
    But orphan step`
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.message.includes("must follow"))
    ).toBe(true);
  });

  it("rejects Given/When/Then outside Scenario", () => {
    const result = validateGherkin(
      `Feature: Test
  Given outside scenario`
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.message.includes("must be inside a Scenario"))
    ).toBe(true);
  });

  it("rejects second Feature when first has no scenarios", () => {
    const result = validateGherkin(
      `Feature: Empty
Feature: Second
  Scenario: OK
    Given a
    When b
    Then c`
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.message.includes("Previous Feature has no Scenarios"))
    ).toBe(true);
  });

  it("rejects second Scenario when first has no steps", () => {
    const result = validateGherkin(
      `Feature: Test
  Scenario: First empty
  Scenario: Second
    Given a
    When b
    Then c`
    );
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.message.includes("no steps"))
    ).toBe(true);
  });

  it("rejects Given at state 'in_feature' (no Scenario yet)", () => {
    const result = validateGherkin(
      `Feature: Test
  Given something without a scenario`
    );
    expect(result.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateGherkin — warnings
// ---------------------------------------------------------------------------

describe("validateGherkin — warnings", () => {
  it("warns on tags with unusual characters", () => {
    const result = validateGherkin(
      `@valid @weird!tag
Feature: Test
  Scenario: Example
    Given a
    When b
    Then c`
    );
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(
      result.warnings.some((w) => w.message.includes("unusual characters"))
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateGherkin — stats
// ---------------------------------------------------------------------------

describe("validateGherkin — stats", () => {
  it("returns correct counts for a complex multi-feature file", () => {
    const result = validateGherkin(
      `@feature-tag
Feature: Feature One
  Background:
    Given shared setup

  @happy
  Scenario: S1
    Given a
    When b
    Then c
    And d

  @edge
  Scenario Outline: S2
    Given <input>
    When process
    Then <output>

    Examples:
      | input | output |
      | x     | y      |

Feature: Feature Two
  Scenario: S3
    Given x
    When y
    Then z`
    );
    expect(result.valid).toBe(true);
    expect(result.stats.features).toBe(2);
    expect(result.stats.scenarios).toBe(3);
    // Steps: shared setup(1) + a,b,c,d(4) + input,process,output(3) + x,y,z(3) = 11
    expect(result.stats.steps).toBe(11);
  });

  it("deduplicates tags", () => {
    const result = validateGherkin(
      `@smoke
Feature: Test
  @smoke @critical
  Scenario: Example
    Given a
    When b
    Then c`
    );
    const smokeCount = result.stats.tags.filter((t) => t === "@smoke").length;
    expect(smokeCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// extractScenarioNames
// ---------------------------------------------------------------------------

describe("extractScenarioNames", () => {
  it("extracts Scenario names", () => {
    const names = extractScenarioNames(
      `Feature: Test
  Scenario: Login success
    Given a
    When b
    Then c
  Scenario: Login failure
    Given a
    When b
    Then c`
    );
    expect(names).toEqual(["Login success", "Login failure"]);
  });

  it("extracts Scenario Outline names", () => {
    const names = extractScenarioNames(
      `Feature: Test
  Scenario Outline: Parameterized test
    Given <a>
    When <b>
    Then <c>`
    );
    expect(names).toEqual(["Parameterized test"]);
  });

  it("returns empty array for no scenarios", () => {
    const names = extractScenarioNames("Feature: Empty");
    expect(names).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// extractFeatureNames
// ---------------------------------------------------------------------------

describe("extractFeatureNames", () => {
  it("extracts feature names", () => {
    const names = extractFeatureNames(
      `Feature: Login
  Scenario: S1
    Given a
    When b
    Then c

Feature: Registration
  Scenario: S2
    Given d
    When e
    Then f`
    );
    expect(names).toEqual(["Login", "Registration"]);
  });

  it("returns empty for no features", () => {
    const names = extractFeatureNames("Some random text");
    expect(names).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// countStepsByType
// ---------------------------------------------------------------------------

describe("countStepsByType", () => {
  it("returns correct counts for mixed steps", () => {
    const counts = countStepsByType(
      `Feature: Test
  Scenario: Mixed
    Given a
    Given b
    When c
    Then d
    And e
    But f`
    );
    expect(counts.given).toBe(2);
    expect(counts.when).toBe(1);
    expect(counts.thenStep).toBe(1);
    expect(counts.and).toBe(1);
    expect(counts.but).toBe(1);
  });

  it("returns all zeros for empty content", () => {
    const counts = countStepsByType("");
    expect(counts).toEqual({ given: 0, when: 0, thenStep: 0, and: 0, but: 0 });
  });
});
