import { internalAction } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { createLLMClient } from "../lib/llm";
import { BDD_FRAMEWORK_MAP } from "../lib/languageDetector";

/**
 * Stage 4: TDD Generation (Step Definitions).
 * Generates executable step definitions for the Gherkin features.
 * Detects the appropriate testing framework based on the repo language.
 */
export const generateTDD = internalAction({
  args: {
    bountyId: v.id("bounties"),
    conversationId: v.id("conversations"),
    generatedTestId: v.id("generatedTests"),
    gherkinPublic: v.string(),
    gherkinHidden: v.string(),
    repoContext: v.optional(v.string()),
    primaryLanguage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    try {
      await ctx.runMutation(internal.conversations.updateStatus, {
        conversationId: args.conversationId,
        status: "generating_tdd",
      });

      const llm = createLLMClient(
        process.env.LLM_PROVIDER,
        process.env.LLM_MODEL,
        process.env.ANTHROPIC_API_KEY,
        process.env.OPENAI_API_KEY
      );

      // Determine the testing framework
      const language = args.primaryLanguage || "typescript";
      const frameworkConfig =
        BDD_FRAMEWORK_MAP[language] || BDD_FRAMEWORK_MAP.typescript;

      // Build repo context
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

      // Generate step definitions separately for public and hidden scenarios
      const generateStepDefs = async (gherkin: string, label: string) => {
        const prompt = `Generate executable step definitions for these Gherkin features.

## Target Framework: ${frameworkConfig.framework}
## Language: ${language}
## Test Runner: ${frameworkConfig.runner}
## Config File: ${frameworkConfig.configFile}

${repoMapText ? `## Repository Structure:\n${repoMapText}\n` : ""}
${relevantChunksText ? `## Relevant Source Code:\n${relevantChunksText}\n` : ""}

## Gherkin Features (${label}):
${gherkin}

## Instructions
- Generate step definition files that implement each Given/When/Then step
- Reference actual module paths, function names, and types from the codebase
- Include necessary imports
- Use the ${frameworkConfig.framework} step definition syntax
- Generate test configuration file (${frameworkConfig.configFile})
- Include setup/teardown hooks if needed
- Step definitions should be in ${language}
- Group step definitions by feature file

Output as JSON:
{
  "files": [
    {"path": "tests/steps/feature_steps.${getExtension(language)}", "content": "..."},
    {"path": "tests/support/world.${getExtension(language)}", "content": "..."},
    {"path": "${frameworkConfig.configFile}", "content": "..."}
  ],
  "framework": "${frameworkConfig.framework}",
  "runCommand": "..."
}`;

        const response = await llm.chat(
          [
            { role: "system", content: prompt },
            {
              role: "user",
              content: "Generate the step definitions and test configuration.",
            },
          ],
          { temperature: 0.3, maxTokens: 8000 }
        );

        try {
          const cleaned = response
            .replace(/^```json\n?/, "")
            .replace(/\n?```$/, "")
            .trim();
          const parsed = JSON.parse(cleaned);
          return {
            stepDefs: JSON.stringify(parsed.files || []),
            framework: parsed.framework || frameworkConfig.framework,
          };
        } catch {
          return { stepDefs: response, framework: frameworkConfig.framework };
        }
      };

      const publicResult = await generateStepDefs(args.gherkinPublic, "public");
      const hiddenResult = await generateStepDefs(args.gherkinHidden, "hidden");

      // Combined step definitions for backward compatibility
      const stepDefinitions = publicResult.stepDefs;
      const testFramework = publicResult.framework;

      // Update the generated tests record with split step definitions
      await ctx.runMutation(internal.generatedTests.updateStepDefinitions, {
        generatedTestId: args.generatedTestId,
        stepDefinitions,
        stepDefinitionsPublic: publicResult.stepDefs,
        stepDefinitionsHidden: hiddenResult.stepDefs,
        testFramework,
        testLanguage: language,
      });

      // Store as conversation message
      await ctx.runMutation(internal.conversations.addMessage, {
        conversationId: args.conversationId,
        role: "assistant",
        content: JSON.stringify({
          type: "tdd_generated",
          framework: testFramework,
          language,
          stepDefinitions,
        }),
      });

      // Move to review
      await ctx.runMutation(internal.conversations.updateStatus, {
        conversationId: args.conversationId,
        status: "review",
      });

      return { stepDefinitions, testFramework };
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : "Unknown error during TDD generation";
      console.error(`generateTDD failed: ${errorMessage}`);

      await ctx.runMutation(internal.conversations.addMessage, {
        conversationId: args.conversationId,
        role: "system",
        content: `TDD generation failed: ${errorMessage}`,
      });

      throw error;
    }
  },
});

function getExtension(language: string): string {
  const extMap: Record<string, string> = {
    typescript: "ts",
    javascript: "js",
    python: "py",
    go: "go",
    rust: "rs",
    java: "java",
    ruby: "rb",
    php: "php",
    csharp: "cs",
    kotlin: "kt",
    c: "c",
    cpp: "cpp",
    swift: "swift",
  };
  return extMap[language] || "ts";
}
