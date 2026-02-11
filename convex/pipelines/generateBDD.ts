import { internalAction } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { createLLMClient } from "../lib/llm";
import { validateGherkin } from "../lib/gherkinValidator";

/**
 * Stage 3: BDD Generation (Gherkin).
 * Generates comprehensive Gherkin feature files from requirements + repo context.
 * Produces two sets: public (visible to agents) and hidden (anti-gaming).
 */
export const generateBDD = internalAction({
  args: {
    bountyId: v.id("bounties"),
    conversationId: v.id("conversations"),
    description: v.string(),
    repoContext: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    try {
      await ctx.runMutation(internal.conversations.updateStatus, {
        conversationId: args.conversationId,
        status: "generating_bdd",
      });

      const llm = createLLMClient(
        process.env.LLM_PROVIDER,
        process.env.LLM_MODEL,
        process.env.ANTHROPIC_API_KEY,
        process.env.OPENAI_API_KEY
      );

      // Get conversation history for context
      const conversation = await ctx.runQuery(internal.conversations.getById, {
        conversationId: args.conversationId,
      });

      const conversationHistory = conversation
        ? conversation.messages
            .filter((m) => m.role !== "system")
            .map((m) => `${m.role}: ${m.content}`)
            .join("\n\n")
        : "";

      // Retrieve repo context if available
      let repoMapText = "";
      let relevantChunksText = "";

      if (args.repoContext) {
        try {
          const context = JSON.parse(args.repoContext);
          repoMapText = context.repoMapText || "";
          relevantChunksText = (context.relevantChunks || [])
            .map(
              (c: { filePath: string; content: string }) =>
                `### ${c.filePath}\n${c.content}`
            )
            .join("\n\n");
        } catch {
          repoMapText = args.repoContext;
        }
      }

      const systemPrompt = `You are an expert BDD test architect. Generate comprehensive Gherkin feature files for this feature request.

${repoMapText ? `## Repository Structure\n${repoMapText}\n` : ""}
${relevantChunksText ? `## Relevant Code\n${relevantChunksText}\n` : ""}

## Feature Request
${args.description}

${conversationHistory ? `## Clarification Answers\n${conversationHistory}\n` : ""}

## Instructions
Generate TWO sets of Gherkin feature files as a JSON response:

### PUBLIC TESTS (visible to solving agents)
Cover the core acceptance criteria:
- Happy path scenarios
- Basic error handling
- Input validation
- Expected API contracts

### HIDDEN TESTS (only run during verification, never shown to agents)
Cover edge cases and anti-gaming measures:
- Boundary conditions
- Concurrency/race conditions
- Security edge cases (injection, overflow)
- Integration with existing codebase patterns
- Performance under load (if applicable)
- Tests that would catch "hardcoded" solutions

## Format
Use standard Gherkin syntax. Each Feature should have a description.
Use Background for shared setup. Use Scenario Outline for parameterized tests.
Tag scenarios: @public or @hidden, @happy-path, @error-case, @edge-case, @security

Respond with JSON:
{
  "public": "Feature: ...\\n  Scenario: ...\\n    Given ...\\n    When ...\\n    Then ...",
  "hidden": "Feature: ...\\n  Scenario: ...\\n    Given ...\\n    When ...\\n    Then ..."
}`;

      const response = await llm.chat(
        [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: "Generate the Gherkin test specifications.",
          },
        ],
        { temperature: 0.4, maxTokens: 8000 }
      );

      // Parse the response
      let gherkinPublic: string;
      let gherkinHidden: string;

      try {
        const cleaned = response
          .replace(/^```json\n?/, "")
          .replace(/\n?```$/, "")
          .trim();
        const parsed = JSON.parse(cleaned);
        gherkinPublic = parsed.public || "";
        gherkinHidden = parsed.hidden || "";
      } catch {
        // If JSON parsing fails, try to split on a known delimiter
        const parts = response.split(/---\s*HIDDEN\s*---/i);
        gherkinPublic = parts[0]
          ?.replace(/^```gherkin\n?/, "")
          .replace(/\n?```$/, "")
          .trim() || "";
        gherkinHidden = (parts[1] || "")
          .replace(/^```gherkin\n?/, "")
          .replace(/\n?```$/, "")
          .trim();
      }

      // Validate both Gherkin files
      const publicValidation = validateGherkin(gherkinPublic);
      const hiddenValidation = validateGherkin(gherkinHidden);

      if (!publicValidation.valid) {
        console.warn(
          "Public Gherkin validation errors:",
          publicValidation.errors
        );
      }
      if (!hiddenValidation.valid) {
        console.warn(
          "Hidden Gherkin validation errors:",
          hiddenValidation.errors
        );
      }

      // Store as conversation message
      await ctx.runMutation(internal.conversations.addMessage, {
        conversationId: args.conversationId,
        role: "assistant",
        content: JSON.stringify({
          type: "bdd_generated",
          public: gherkinPublic,
          hidden: gherkinHidden,
          publicValidation: {
            valid: publicValidation.valid,
            stats: publicValidation.stats,
          },
          hiddenValidation: {
            valid: hiddenValidation.valid,
            stats: hiddenValidation.stats,
          },
        }),
      });

      // Store generated tests
      await ctx.runMutation(internal.generatedTests.create, {
        bountyId: args.bountyId,
        conversationId: args.conversationId,
        gherkinPublic,
        gherkinHidden,
        stepDefinitions: "", // Generated in next stage
        testFramework: "cucumber-js", // Default, will be updated
        testLanguage: "typescript", // Default, will be updated
        llmModel: llm.model,
      });

      // Update conversation status
      await ctx.runMutation(internal.conversations.updateStatus, {
        conversationId: args.conversationId,
        status: "review",
      });

      return { gherkinPublic, gherkinHidden };
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : "Unknown error during BDD generation";
      console.error(`generateBDD failed: ${errorMessage}`);

      await ctx.runMutation(internal.conversations.addMessage, {
        conversationId: args.conversationId,
        role: "system",
        content: `BDD generation failed: ${errorMessage}`,
      });

      throw error;
    }
  },
});
