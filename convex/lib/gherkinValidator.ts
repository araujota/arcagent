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

type StepType = "given" | "when" | "then" | null;

interface ValidationContext {
  errors: ValidationError[];
  warnings: ValidationWarning[];
  tags: string[];
  state: ParseState;
  featureCount: number;
  scenarioCount: number;
  stepCount: number;
  currentFeatureHasScenario: boolean;
  currentScenarioHasStep: boolean;
  lastStepType: StepType;
}

function createValidationContext(): ValidationContext {
  return {
    errors: [],
    warnings: [],
    tags: [],
    state: "start",
    featureCount: 0,
    scenarioCount: 0,
    stepCount: 0,
    currentFeatureHasScenario: false,
    currentScenarioHasStep: false,
    lastStepType: null,
  };
}

function pushTagWarningsAndTags(ctx: ValidationContext, line: string, lineNum: number): void {
  const tagMatches = line.match(/@\S+/g);
  if (!tagMatches) return;
  for (const tag of tagMatches) {
    if (!/^@[\w-]+$/.test(tag)) {
      ctx.warnings.push({
        line: lineNum,
        message: `Tag "${tag}" contains unusual characters`,
      });
    }
    ctx.tags.push(tag);
  }
}

function handleStructuralLine(ctx: ValidationContext, line: string, lineNum: number): boolean {
  if (FEATURE_REGEX.test(line)) {
    if (ctx.featureCount > 0 && !ctx.currentFeatureHasScenario) {
      ctx.errors.push({
        line: lineNum,
        message: "Previous Feature has no Scenarios",
      });
    }
    ctx.featureCount++;
    ctx.currentFeatureHasScenario = false;
    ctx.state = "in_feature";
    return true;
  }

  if (BACKGROUND_REGEX.test(line)) {
    if (ctx.state === "start") {
      ctx.errors.push({
        line: lineNum,
        message: "Background must be inside a Feature",
      });
    }
    ctx.state = "in_background";
    ctx.lastStepType = null;
    return true;
  }

  if (SCENARIO_REGEX.test(line) || SCENARIO_OUTLINE_REGEX.test(line)) {
    if (ctx.state === "start") {
      ctx.errors.push({
        line: lineNum,
        message: "Scenario must be inside a Feature",
      });
    }
    if (ctx.scenarioCount > 0 && !ctx.currentScenarioHasStep) {
      ctx.errors.push({
        line: lineNum,
        message: "Previous Scenario has no steps (Given/When/Then)",
      });
    }
    ctx.scenarioCount++;
    ctx.currentFeatureHasScenario = true;
    ctx.currentScenarioHasStep = false;
    ctx.lastStepType = null;
    ctx.state = "in_scenario";
    return true;
  }

  return false;
}

function isStepContext(state: ParseState): boolean {
  return state === "in_scenario" || state === "in_background" || state === "after_step";
}

function handleStepLine(ctx: ValidationContext, line: string, lineNum: number): boolean {
  if (GIVEN_REGEX.test(line)) {
    if (!isStepContext(ctx.state)) {
      ctx.errors.push({
        line: lineNum,
        message: "Given must be inside a Scenario or Background",
      });
    }
    ctx.lastStepType = "given";
    ctx.currentScenarioHasStep = true;
    ctx.stepCount++;
    ctx.state = "after_step";
    return true;
  }

  if (WHEN_REGEX.test(line)) {
    if (ctx.state !== "in_scenario" && ctx.state !== "after_step") {
      ctx.errors.push({
        line: lineNum,
        message: "When must be inside a Scenario",
      });
    }
    ctx.lastStepType = "when";
    ctx.currentScenarioHasStep = true;
    ctx.stepCount++;
    ctx.state = "after_step";
    return true;
  }

  if (THEN_REGEX.test(line)) {
    if (ctx.state !== "in_scenario" && ctx.state !== "after_step") {
      ctx.errors.push({
        line: lineNum,
        message: "Then must be inside a Scenario",
      });
    }
    ctx.lastStepType = "then";
    ctx.currentScenarioHasStep = true;
    ctx.stepCount++;
    ctx.state = "after_step";
    return true;
  }

  if (AND_REGEX.test(line) || BUT_REGEX.test(line)) {
    if (ctx.lastStepType === null) {
      ctx.errors.push({
        line: lineNum,
        message: `"${line.trim().split(" ")[0]}" must follow a Given, When, or Then step`,
      });
    }
    ctx.currentScenarioHasStep = true;
    ctx.stepCount++;
    ctx.state = "after_step";
    return true;
  }

  return false;
}

function processValidationLine(ctx: ValidationContext, line: string, lineNum: number): void {
  const trimmed = line.trim();

  if (trimmed === "" || trimmed.startsWith("#")) {
    return;
  }

  if (DOC_STRING_REGEX.test(line)) {
    ctx.state = ctx.state === "in_doc_string" ? "after_step" : "in_doc_string";
    return;
  }

  if (ctx.state === "in_doc_string") {
    return;
  }

  if (TAG_REGEX.test(line)) {
    pushTagWarningsAndTags(ctx, line, lineNum);
    return;
  }

  if (TABLE_ROW_REGEX.test(line)) {
    return;
  }

  if (EXAMPLES_REGEX.test(line)) {
    ctx.state = "in_examples";
    return;
  }

  if (handleStructuralLine(ctx, line, lineNum)) {
    return;
  }

  if (handleStepLine(ctx, line, lineNum)) {
    return;
  }
}

/**
 * Validate a Gherkin feature file string.
 */
export function validateGherkin(content: string): ValidationResult {
  const lines = content.split("\n");
  const ctx = createValidationContext();

  for (let i = 0; i < lines.length; i++) {
    processValidationLine(ctx, lines[i], i + 1);
  }

  // Final checks
  if (ctx.featureCount > 0 && !ctx.currentFeatureHasScenario) {
    ctx.errors.push({
      line: lines.length,
      message: "Feature has no Scenarios",
    });
  }

  if (ctx.scenarioCount > 0 && !ctx.currentScenarioHasStep) {
    ctx.errors.push({
      line: lines.length,
      message: "Last Scenario has no steps",
    });
  }

  if (ctx.featureCount === 0) {
    ctx.errors.push({
      line: 1,
      message: "No Feature found in Gherkin content",
    });
  }

  return {
    valid: ctx.errors.length === 0,
    errors: ctx.errors,
    warnings: ctx.warnings,
    stats: {
      features: ctx.featureCount,
      scenarios: ctx.scenarioCount,
      steps: ctx.stepCount,
      tags: [...new Set(ctx.tags)],
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
