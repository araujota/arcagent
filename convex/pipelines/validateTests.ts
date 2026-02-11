import { internalAction } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { createLLMClient } from "../lib/llm";
import { validateGherkin, extractScenarioNames } from "../lib/gherkinValidator";

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
  },
  handler: async (ctx, args) => {
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
      // If step definitions aren't JSON array, check raw content
      if (args.stepDefinitions.trim().length === 0) {
        issues.push("No step definitions generated");
      }
    }

    // Check that step definition files have content
    for (const file of stepDefFiles) {
      if (!file.content || file.content.trim().length === 0) {
        issues.push(`Step definition file ${file.path} is empty`);
      }
    }

    // 4. LLM self-review for coverage gaps
    let coverageReview: string | null = null;
    try {
      const llm = createLLMClient(
        process.env.LLM_PROVIDER,
        process.env.LLM_MODEL,
        process.env.ANTHROPIC_API_KEY,
        process.env.OPENAI_API_KEY
      );

      const reviewPrompt = `Review these Gherkin features and step definitions for completeness.

## Public Gherkin
${args.gherkinPublic}

## Hidden Gherkin
${args.gherkinHidden}

## Step Definitions
${args.stepDefinitions}

Identify:
1. Missing scenarios (edge cases not covered)
2. Redundant tests
3. Steps without matching definitions
4. Potential anti-gaming gaps

Respond with a brief JSON:
{
  "score": 1-10,
  "missingScenarios": ["..."],
  "redundantTests": ["..."],
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
    } catch (reviewError) {
      console.warn("LLM self-review failed:", reviewError);
    }

    // Store validation results
    const validationResult = {
      valid: issues.length === 0,
      issues,
      warnings,
      stats: {
        publicScenarios: publicScenarios.length,
        hiddenScenarios: hiddenScenarios.length,
        stepDefFiles: stepDefFiles.length,
        publicGherkinStats: publicValidation.stats,
        hiddenGherkinStats: hiddenValidation.stats,
      },
      coverageReview,
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
