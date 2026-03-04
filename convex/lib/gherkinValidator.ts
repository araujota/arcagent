/**
 * Gherkin syntax validator.
 * Simple state-machine parser that validates Gherkin feature files.
 *
 * Checks:
 * - Every Feature: has at least one Scenario:
 * - Every Scenario: has at least one Given/When/Then
 * - No orphaned And/But without preceding step
 * - Tags are valid format (@word)
 */

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
  stats: {
    features: number;
    scenarios: number;
    steps: number;
    tags: string[];
  };
}

export interface ValidationError {
  line: number;
  message: string;
}

export interface ValidationWarning {
  line: number;
  message: string;
}

const FEATURE_REGEX = /^\s*Feature:\s*(.+)/;
const SCENARIO_REGEX = /^\s*Scenario:\s*(.+)/;
const SCENARIO_OUTLINE_REGEX = /^\s*Scenario Outline:\s*(.+)/;
const BACKGROUND_REGEX = /^\s*Background:\s*/;
const GIVEN_REGEX = /^\s*Given\s+(.+)/;
const WHEN_REGEX = /^\s*When\s+(.+)/;
const THEN_REGEX = /^\s*Then\s+(.+)/;
const AND_REGEX = /^\s*And\s+(.+)/;
const BUT_REGEX = /^\s*But\s+(.+)/;
const TAG_REGEX = /^\s*(@\S+)/;
const EXAMPLES_REGEX = /^\s*Examples:\s*/;
const TABLE_ROW_REGEX = /^\s*\|/;
const DOC_STRING_REGEX = /^\s*"""/;

type ParseState =
  | "start"
  | "in_feature"
  | "in_scenario"
  | "in_background"
  | "after_step"
  | "in_examples"
  | "in_doc_string";

/**
 * Validate a Gherkin feature file string.
 */
export function validateGherkin(content: string): ValidationResult {
  const lines = content.split("\n");
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];
  const tags: string[] = [];

  let state: ParseState = "start";
  let featureCount = 0;
  let scenarioCount = 0;
  let stepCount = 0;
  let currentFeatureHasScenario = false;
  let currentScenarioHasStep = false;
  let lastStepType: "given" | "when" | "then" | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Skip empty lines and comments
    if (line.trim() === "" || line.trim().startsWith("#")) {
      continue;
    }

    // Handle doc strings
    if (DOC_STRING_REGEX.test(line)) {
      if (state === "in_doc_string") {
        state = "after_step";
      } else {
        state = "in_doc_string";
      }
      continue;
    }

    if (state === "in_doc_string") {
      continue; // Skip content inside doc strings
    }

    // Handle tags
    if (TAG_REGEX.test(line)) {
      const tagMatches = line.match(/@\S+/g);
      if (tagMatches) {
        for (const tag of tagMatches) {
          if (!/^@[\w-]+$/.test(tag)) {
            warnings.push({
              line: lineNum,
              message: `Tag "${tag}" contains unusual characters`,
            });
          }
          tags.push(tag);
        }
      }
      continue;
    }

    // Handle table rows
    if (TABLE_ROW_REGEX.test(line)) {
      continue;
    }

    // Handle Examples section
    if (EXAMPLES_REGEX.test(line)) {
      state = "in_examples";
      continue;
    }

    // Feature
    if (FEATURE_REGEX.test(line)) {
      if (featureCount > 0 && !currentFeatureHasScenario) {
        errors.push({
          line: lineNum,
          message: "Previous Feature has no Scenarios",
        });
      }
      featureCount++;
      currentFeatureHasScenario = false;
      state = "in_feature";
      continue;
    }

    // Background
    if (BACKGROUND_REGEX.test(line)) {
      if (state === "start") {
        errors.push({
          line: lineNum,
          message: "Background must be inside a Feature",
        });
      }
      state = "in_background";
      lastStepType = null;
      continue;
    }

    // Scenario or Scenario Outline
    if (SCENARIO_REGEX.test(line) || SCENARIO_OUTLINE_REGEX.test(line)) {
      if (state === "start") {
        errors.push({
          line: lineNum,
          message: "Scenario must be inside a Feature",
        });
      }
      if (scenarioCount > 0 && !currentScenarioHasStep) {
        errors.push({
          line: lineNum,
          message: "Previous Scenario has no steps (Given/When/Then)",
        });
      }
      scenarioCount++;
      currentFeatureHasScenario = true;
      currentScenarioHasStep = false;
      lastStepType = null;
      state = "in_scenario";
      continue;
    }

    // Given
    if (GIVEN_REGEX.test(line)) {
      if (state !== "in_scenario" && state !== "in_background" && state !== "after_step") {
        errors.push({
          line: lineNum,
          message: "Given must be inside a Scenario or Background",
        });
      }
      lastStepType = "given";
      currentScenarioHasStep = true;
      stepCount++;
      state = "after_step";
      continue;
    }

    // When
    if (WHEN_REGEX.test(line)) {
      if (state !== "in_scenario" && state !== "after_step") {
        errors.push({
          line: lineNum,
          message: "When must be inside a Scenario",
        });
      }
      lastStepType = "when";
      currentScenarioHasStep = true;
      stepCount++;
      state = "after_step";
      continue;
    }

    // Then
    if (THEN_REGEX.test(line)) {
      if (state !== "in_scenario" && state !== "after_step") {
        errors.push({
          line: lineNum,
          message: "Then must be inside a Scenario",
        });
      }
      lastStepType = "then";
      currentScenarioHasStep = true;
      stepCount++;
      state = "after_step";
      continue;
    }

    // And / But
    if (AND_REGEX.test(line) || BUT_REGEX.test(line)) {
      if (lastStepType === null) {
        errors.push({
          line: lineNum,
          message: `"${line.trim().split(" ")[0]}" must follow a Given, When, or Then step`,
        });
      }
      currentScenarioHasStep = true;
      stepCount++;
      state = "after_step";
      continue;
    }

    // Unrecognized line (could be description text)
    if (
      state === "in_feature" ||
      state === "in_scenario" ||
      state === "in_background"
    ) {
      // Description text is allowed after Feature/Scenario/Background
      continue;
    }
  }

  // Final checks
  if (featureCount > 0 && !currentFeatureHasScenario) {
    errors.push({
      line: lines.length,
      message: "Feature has no Scenarios",
    });
  }

  if (scenarioCount > 0 && !currentScenarioHasStep) {
    errors.push({
      line: lines.length,
      message: "Last Scenario has no steps",
    });
  }

  if (featureCount === 0) {
    errors.push({
      line: 1,
      message: "No Feature found in Gherkin content",
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    stats: {
      features: featureCount,
      scenarios: scenarioCount,
      steps: stepCount,
      tags: [...new Set(tags)],
    },
  };
}

/**
 * Extract scenario names from Gherkin content.
 */
export function extractScenarioNames(content: string): string[] {
  const names: string[] = [];
  const lines = content.split("\n");

  for (const line of lines) {
    const scenarioMatch = line.match(SCENARIO_REGEX);
    if (scenarioMatch) {
      names.push(scenarioMatch[1].trim());
    }
    const outlineMatch = line.match(SCENARIO_OUTLINE_REGEX);
    if (outlineMatch) {
      names.push(outlineMatch[1].trim());
    }
  }

  return names;
}

/**
 * Extract feature names from Gherkin content.
 */
export function extractFeatureNames(content: string): string[] {
  const names: string[] = [];
  const lines = content.split("\n");

  for (const line of lines) {
    const match = line.match(FEATURE_REGEX);
    if (match) {
      names.push(match[1].trim());
    }
  }

  return names;
}

/**
 * Count steps in Gherkin content by type.
 */
export function countStepsByType(content: string): {
  given: number;
  when: number;
  thenStep: number;
  and: number;
  but: number;
} {
  const lines = content.split("\n");
  const counts = { given: 0, when: 0, thenStep: 0, and: 0, but: 0 };

  for (const line of lines) {
    if (GIVEN_REGEX.test(line)) counts.given++;
    else if (WHEN_REGEX.test(line)) counts.when++;
    else if (THEN_REGEX.test(line)) counts.thenStep++;
    else if (AND_REGEX.test(line)) counts.and++;
    else if (BUT_REGEX.test(line)) counts.but++;
  }

  return counts;
}
