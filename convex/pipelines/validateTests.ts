import { internalAction } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { createLLMClient } from "../lib/llm";
import { validateGherkin, extractScenarioNames } from "../lib/gherkinValidator";
import { verifyBddStepCoverage } from "../lib/bddStepVerifier";

// ---------------------------------------------------------------------------
// Extracted pure helpers (testable without Convex runtime)
// ---------------------------------------------------------------------------

export interface StaticValidationResult {
  issues: string[];
  warnings: string[];
  quality: {
    hasPublicTagCoverage: boolean;
    hasHiddenTagCoverage: boolean;
    outlineCount: number;
    hasOutlineExamplesWithMinRows: boolean;
  };
  stats: {
    publicScenarios: number;
    hiddenScenarios: number;
    stepDefFiles: number;
    publicGherkinStats: ReturnType<typeof validateGherkin>["stats"];
    hiddenGherkinStats: ReturnType<typeof validateGherkin>["stats"];
  };
}

export interface RunStaticValidationArgs {
  gherkinPublic: string;
  gherkinHidden: string;
  stepDefinitions: string;
  stepDefinitionsPublic?: string;
  stepDefinitionsHidden?: string;
}

const MIN_PUBLIC_SCENARIOS = 8;
const MIN_HIDDEN_SCENARIOS = 8;
const MIN_LLM_SCORE = 7;

type GherkinValidation = ReturnType<typeof validateGherkin>;

function countRegexMatches(content: string, pattern: RegExp): number {
  return (content.match(pattern) ?? []).length;
}

function hasRequiredTags(content: string, required: string[]): boolean {
  const normalized = content.toLowerCase();
  return required.every((tag) => normalized.includes(tag));
}

function hasExamplesTableWithMinRows(content: string, minRows: number): boolean {
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*Examples:\s*$/i.test(lines[i])) continue;
    let rows = 0;
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === "") j++;
    while (j < lines.length && /^\s*\|/.test(lines[j])) {
      rows++;
      j++;
    }
    // Includes header row; require header + min data rows.
    if (rows >= minRows + 1) return true;
  }
  return false;
}

function appendValidationErrors(
  label: "Public" | "Hidden",
  validation: GherkinValidation,
  issues: string[],
): void {
  if (validation.valid) return;
  for (const error of validation.errors) {
    issues.push(`${label} Gherkin line ${error.line}: ${error.message}`);
  }
}

function appendValidationWarnings(
  validations: GherkinValidation[],
  warnings: string[],
): void {
  for (const warning of validations.flatMap((validation) => validation.warnings)) {
    warnings.push(`Line ${warning.line}: ${warning.message}`);
  }
}

function appendScenarioCountIssues(
  publicScenarioCount: number,
  hiddenScenarioCount: number,
  issues: string[],
): void {
  if (publicScenarioCount < MIN_PUBLIC_SCENARIOS) {
    issues.push(
      `Public Gherkin has ${publicScenarioCount} scenarios; minimum is ${MIN_PUBLIC_SCENARIOS}`
    );
  }
  if (hiddenScenarioCount < MIN_HIDDEN_SCENARIOS) {
    issues.push(
      `Hidden Gherkin has ${hiddenScenarioCount} scenarios; minimum is ${MIN_HIDDEN_SCENARIOS}`
    );
  }
}

function evaluateOutlineQuality(
  gherkinPublic: string,
  gherkinHidden: string,
  issues: string[],
): { outlineCount: number; hasOutlineExamplesWithMinRows: boolean } {
  const outlineCount =
    countRegexMatches(gherkinPublic, /^\s*Scenario Outline:\s+/gim) +
    countRegexMatches(gherkinHidden, /^\s*Scenario Outline:\s+/gim);
  if (outlineCount < 2) {
    issues.push("At least 2 Scenario Outline cases are required across public+hidden tests");
  }

  const hasOutlineExamplesWithMinRows = hasExamplesTableWithMinRows(
    `${gherkinPublic}\n${gherkinHidden}`,
    4
  );
  if (!hasOutlineExamplesWithMinRows) {
    issues.push("At least one Examples table must contain 4 or more data rows");
  }

  return { outlineCount, hasOutlineExamplesWithMinRows };
}

function evaluateTagCoverage(
  gherkinPublic: string,
  gherkinHidden: string,
  issues: string[],
): { hasPublicTagCoverage: boolean; hasHiddenTagCoverage: boolean } {
  const hasPublicTagCoverage = hasRequiredTags(gherkinPublic, [
    "@public",
    "@happy-path",
    "@validation",
    "@error",
  ]);
  if (!hasPublicTagCoverage) {
    issues.push("Public tests must include tags: @public, @happy-path, @validation, @error");
  }

  const hasHiddenTagCoverage = hasRequiredTags(gherkinHidden, [
    "@hidden",
    "@boundary",
    "@security",
    "@anti-gaming",
  ]);
  if (!hasHiddenTagCoverage) {
    issues.push("Hidden tests must include tags: @hidden, @boundary, @security, @anti-gaming");
  }

  return { hasPublicTagCoverage, hasHiddenTagCoverage };
}

/**
 * Run static (non-LLM) validation on generated Gherkin + step definitions.
 */
export function runStaticValidation(
  args: RunStaticValidationArgs
): StaticValidationResult {
  const issues: string[] = [];
  const warnings: string[] = [];

  // 1. Gherkin syntax validation
  const publicValidation = validateGherkin(args.gherkinPublic);
  const hiddenValidation = validateGherkin(args.gherkinHidden);

  appendValidationErrors("Public", publicValidation, issues);
  appendValidationErrors("Hidden", hiddenValidation, issues);
  appendValidationWarnings([publicValidation, hiddenValidation], warnings);

  // 2. Check scenario inventory
  const publicScenarios = extractScenarioNames(args.gherkinPublic);
  const hiddenScenarios = extractScenarioNames(args.gherkinHidden);
  const allScenarios = [...publicScenarios, ...hiddenScenarios];

  if (allScenarios.length === 0) {
    issues.push("No scenarios found in generated Gherkin");
  }

  // 3. Step definition coverage + expression validity checks.
  // This protects against malformed Cucumber expressions and unmatched
  // Given/When/Then lines before tests are ever published.
  const noStepDefsProvided =
    (!args.stepDefinitions || args.stepDefinitions.trim().length === 0) &&
    (!args.stepDefinitionsPublic || args.stepDefinitionsPublic.trim().length === 0) &&
    (!args.stepDefinitionsHidden || args.stepDefinitionsHidden.trim().length === 0);
  if (noStepDefsProvided) {
    issues.push("No step definitions generated");
  }

  const stepCoverage = verifyBddStepCoverage({
    gherkinPublic: args.gherkinPublic,
    gherkinHidden: args.gherkinHidden,
    stepDefinitionPayloads: [
      { label: "combined", serialized: args.stepDefinitions },
      { label: "public", serialized: args.stepDefinitionsPublic },
      { label: "hidden", serialized: args.stepDefinitionsHidden },
    ],
  });
  issues.push(...stepCoverage.issues);
  warnings.push(...stepCoverage.warnings);

  appendScenarioCountIssues(publicScenarios.length, hiddenScenarios.length, issues);
  const outlineQuality = evaluateOutlineQuality(
    args.gherkinPublic,
    args.gherkinHidden,
    issues,
  );
  const tagCoverage = evaluateTagCoverage(
    args.gherkinPublic,
    args.gherkinHidden,
    issues,
  );

  return {
    issues,
    warnings,
    quality: {
      hasPublicTagCoverage: tagCoverage.hasPublicTagCoverage,
      hasHiddenTagCoverage: tagCoverage.hasHiddenTagCoverage,
      outlineCount: outlineQuality.outlineCount,
      hasOutlineExamplesWithMinRows: outlineQuality.hasOutlineExamplesWithMinRows,
    },
    stats: {
      publicScenarios: publicScenarios.length,
      hiddenScenarios: hiddenScenarios.length,
      stepDefFiles: stepCoverage.stats.stepDefinitionFiles,
      publicGherkinStats: publicValidation.stats,
      hiddenGherkinStats: hiddenValidation.stats,
    },
  };
}

// ---------------------------------------------------------------------------
// Convex internalAction handler
// ---------------------------------------------------------------------------

/**
 * Stage 5: Validation & Self-Review.
 * Validates generated tests for syntax, coverage, and consistency.
 */
export const validateTests = internalAction({
  args: {
    bountyId: v.id("bounties"),
    conversationId: v.id("conversations"),
    generatedTestId: v.id("generatedTests"),
    gherkinPublic: v.string(),
    gherkinHidden: v.string(),
    stepDefinitions: v.string(),
    stepDefinitionsPublic: v.optional(v.string()),
    stepDefinitionsHidden: v.optional(v.string()),
    extractedCriteria: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    // Run static validation
    const staticResult = runStaticValidation({
      gherkinPublic: args.gherkinPublic,
      gherkinHidden: args.gherkinHidden,
      stepDefinitions: args.stepDefinitions,
      stepDefinitionsPublic: args.stepDefinitionsPublic,
      stepDefinitionsHidden: args.stepDefinitionsHidden,
    });

    const { issues, warnings, stats } = staticResult;

    // LLM self-review for coverage gaps
    let coverageReview: string | null = null;
    let parsedReview: {
      score?: number;
      criteriaCoverage?: Array<{
        criterion: string;
        coveredBy: string[];
        covered: boolean;
      }>;
      missingScenarios?: string[];
      unmatchedSteps?: string[];
      suggestions?: string[];
    } | null = null;

    try {
      const llm = createLLMClient(
        process.env.LLM_PROVIDER,
        process.env.LLM_MODEL,
        process.env.ANTHROPIC_API_KEY,
        process.env.OPENAI_API_KEY
      );

      const criteriaSection =
        args.extractedCriteria && args.extractedCriteria.length > 0
          ? `## Acceptance Criteria (ALL must be covered)
${args.extractedCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}

For each acceptance criterion, identify which scenario(s) cover it.
Flag any criteria with NO covering scenario.
`
          : "";

      const reviewPrompt = `Review these Gherkin features and step definitions for completeness.

${criteriaSection}
## Public Gherkin
${args.gherkinPublic}

## Hidden Gherkin
${args.gherkinHidden}

## Step Definitions
${args.stepDefinitions}

Identify:
1. Missing scenarios (edge cases not covered)
2. Steps without matching definitions
3. Potential anti-gaming gaps

Respond with JSON:
{
  "score": 1-10,
  "criteriaCoverage": [
    {"criterion": "...", "coveredBy": ["Scenario: ..."], "covered": true}
  ],
  "missingScenarios": ["..."],
  "unmatchedSteps": ["..."],
  "suggestions": ["..."]
}`;

      coverageReview = await llm.chat(
        [
          { role: "system", content: "You are a test review expert." },
          { role: "user", content: reviewPrompt },
        ],
        { temperature: 0.2, maxTokens: 2000 }
      );

      // Try to parse the LLM review
      try {
        const cleaned = coverageReview
          .replace(/^```json\n?/, "")
          .replace(/\n?```$/, "")
          .trim();
        parsedReview = JSON.parse(cleaned);
      } catch {
        // Keep raw string if parsing fails
      }
    } catch (reviewError) {
      console.warn("LLM self-review failed:", reviewError);
    }

    // Determine if regeneration is needed
    const score = parsedReview?.score ?? MIN_LLM_SCORE;
    const uncoveredCriteria =
      parsedReview?.criteriaCoverage?.filter((c) => !c.covered) ?? [];
    const llmMissingScenarios = parsedReview?.missingScenarios?.length ?? 0;
    const llmUnmatchedSteps = parsedReview?.unmatchedSteps?.length ?? 0;
    const needsRegeneration =
      issues.length > 0 ||
      score < MIN_LLM_SCORE ||
      uncoveredCriteria.length > 0 ||
      llmMissingScenarios > 0 ||
      llmUnmatchedSteps > 0;

    // Store validation results
    const validationResult = {
      valid: issues.length === 0,
      issues,
      warnings,
      quality: staticResult.quality,
      stats,
      coverageReview,
      parsedReview,
      needsRegeneration,
      uncoveredCriteria: uncoveredCriteria.map((c) => c.criterion),
    };

    // Store as conversation message
    await ctx.runMutation(internal.conversations.addMessage, {
      conversationId: args.conversationId,
      role: "system",
      content: JSON.stringify({
        type: "validation_result",
        ...validationResult,
      }),
    });

    // Update test status
    if (validationResult.valid) {
      await ctx.runMutation(internal.generatedTests.updateStatus, {
        generatedTestId: args.generatedTestId,
        status: "draft",
      });
    }

    return validationResult;
  },
});
