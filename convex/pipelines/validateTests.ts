import { internalAction } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { createLLMClient } from "../lib/llm";
import { validateGherkin, extractScenarioNames } from "../lib/gherkinValidator";

// ---------------------------------------------------------------------------
// Extracted pure helpers (testable without Convex runtime)
// ---------------------------------------------------------------------------

export interface StaticValidationResult {
  issues: string[];
  warnings: string[];
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

  if (!publicValidation.valid) {
    for (const error of publicValidation.errors) {
      issues.push(`Public Gherkin line ${error.line}: ${error.message}`);
    }
  }

  if (!hiddenValidation.valid) {
    for (const error of hiddenValidation.errors) {
      issues.push(`Hidden Gherkin line ${error.line}: ${error.message}`);
    }
  }

  for (const warning of [
    ...publicValidation.warnings,
    ...hiddenValidation.warnings,
  ]) {
    warnings.push(`Line ${warning.line}: ${warning.message}`);
  }

  // 2. Check step definition coverage
  const publicScenarios = extractScenarioNames(args.gherkinPublic);
  const hiddenScenarios = extractScenarioNames(args.gherkinHidden);
  const allScenarios = [...publicScenarios, ...hiddenScenarios];

  if (allScenarios.length === 0) {
    issues.push("No scenarios found in generated Gherkin");
  }

  // 3. Basic step definition syntax check
  let stepDefFiles: Array<{ path: string; content: string }> = [];
  try {
    stepDefFiles = JSON.parse(args.stepDefinitions);
  } catch {
    if (args.stepDefinitions.trim().length === 0) {
      issues.push("No step definitions generated");
    }
  }

  for (const file of stepDefFiles) {
    if (!file.content || file.content.trim().length === 0) {
      issues.push(`Step definition file ${file.path} is empty`);
    }
  }

  return {
    issues,
    warnings,
    stats: {
      publicScenarios: publicScenarios.length,
      hiddenScenarios: hiddenScenarios.length,
      stepDefFiles: stepDefFiles.length,
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
    extractedCriteria: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    // Run static validation
    const staticResult = runStaticValidation({
      gherkinPublic: args.gherkinPublic,
      gherkinHidden: args.gherkinHidden,
      stepDefinitions: args.stepDefinitions,
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
    const score = parsedReview?.score ?? 10;
    const uncoveredCriteria =
      parsedReview?.criteriaCoverage?.filter((c) => !c.covered) ?? [];
    const needsRegeneration =
      score < 6 ||
      uncoveredCriteria.length > 0 ||
      stats.publicScenarios < 8;

    // Store validation results
    const validationResult = {
      valid: issues.length === 0,
      issues,
      warnings,
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
