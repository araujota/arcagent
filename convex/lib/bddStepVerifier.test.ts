import { describe, expect, it } from "vitest";
import {
  loadStepDefinitionFiles,
  verifyBddStepCoverage,
} from "./bddStepVerifier";

const PUBLIC_GHERKIN = `Feature: Public
  Scenario: Happy path
    Given a public precondition
    When a public action happens
    Then a public result appears`;

const HIDDEN_GHERKIN = `Feature: Hidden
  Scenario: Hidden path
    Given a hidden precondition
    Then a hidden result appears`;

describe("loadStepDefinitionFiles", () => {
  it("loads JSON payload arrays and deduplicates duplicate entries", () => {
    const json = JSON.stringify([
      { path: "steps/a.steps.js", content: "Given('x', () => {});" },
      { path: "steps/a.steps.js", content: "Given('x', () => {});" },
    ]);
    const result = loadStepDefinitionFiles([
      { label: "public", serialized: json },
      { label: "hidden", serialized: json },
    ]);
    expect(result.issues).toHaveLength(0);
    expect(result.files).toHaveLength(1);
  });

  it("accepts non-JSON payloads as inline source for backward compatibility", () => {
    const result = loadStepDefinitionFiles([
      { label: "combined", serialized: "Given('x', () => {});" },
    ]);
    expect(result.issues).toHaveLength(0);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].path).toContain("inline-combined");
  });
});

describe("verifyBddStepCoverage", () => {
  it("passes when every Gherkin step has a matching step definition", () => {
    const publicSteps = JSON.stringify([
      {
        path: "steps/public.steps.js",
        content: `
          const { Given, When, Then } = require('@cucumber/cucumber');
          Given('a public precondition', () => {});
          When('a public action happens', () => {});
          Then('a public result appears', () => {});
        `,
      },
    ]);
    const hiddenSteps = JSON.stringify([
      {
        path: "steps/hidden.steps.js",
        content: `
          const { Given, Then } = require('@cucumber/cucumber');
          Given('a hidden precondition', () => {});
          Then('a hidden result appears', () => {});
        `,
      },
    ]);

    const result = verifyBddStepCoverage({
      gherkinPublic: PUBLIC_GHERKIN,
      gherkinHidden: HIDDEN_GHERKIN,
      stepDefinitionPayloads: [
        { label: "public", serialized: publicSteps },
        { label: "hidden", serialized: hiddenSteps },
      ],
    });

    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
    expect(result.stats.unmatchedSteps).toBe(0);
  });

  it("reports unmatched steps when definitions are missing", () => {
    const stepDefs = JSON.stringify([
      {
        path: "steps/public.steps.js",
        content: `
          const { Given } = require('@cucumber/cucumber');
          Given('a public precondition', () => {});
        `,
      },
    ]);

    const result = verifyBddStepCoverage({
      gherkinPublic: PUBLIC_GHERKIN,
      gherkinHidden: HIDDEN_GHERKIN,
      stepDefinitionPayloads: [{ label: "combined", serialized: stepDefs }],
    });

    expect(result.valid).toBe(false);
    expect(result.stats.unmatchedSteps).toBeGreaterThan(0);
    expect(
      result.issues.some((issue) => issue.includes("Unmatched public Gherkin step")),
    ).toBe(true);
  });

  it("reports invalid slash alternatives in string cucumber expressions", () => {
    const stepDefs = JSON.stringify([
      {
        path: "steps/hidden.steps.js",
        content: `
          const { Then } = require('@cucumber/cucumber');
          Then('the sidebar includes a navigation link to /agenthellos', () => {});
        `,
      },
    ]);

    const result = verifyBddStepCoverage({
      gherkinPublic: "",
      gherkinHidden: `Feature: Hidden
  Scenario: S
    Then the sidebar includes a navigation link to /agenthellos`,
      stepDefinitionPayloads: [{ label: "hidden", serialized: stepDefs }],
    });

    expect(result.valid).toBe(false);
    expect(
      result.issues.some((issue) =>
        issue.includes('invalid "/" alternative boundary'),
      ),
    ).toBe(true);
  });

  it("supports regex step definitions for slash-heavy routes", () => {
    const stepDefs = JSON.stringify([
      {
        path: "steps/hidden.steps.js",
        content: `
          const { Then } = require('@cucumber/cucumber');
          Then(/the sidebar includes a navigation link to \\/agenthellos/, () => {});
        `,
      },
    ]);

    const result = verifyBddStepCoverage({
      gherkinPublic: "",
      gherkinHidden: `Feature: Hidden
  Scenario: S
    Then the sidebar includes a navigation link to /agenthellos`,
      stepDefinitionPayloads: [{ label: "hidden", serialized: stepDefs }],
    });

    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });
});
