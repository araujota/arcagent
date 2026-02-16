import { internalAction } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { createLLMClient } from "../lib/llm";
import { BDD_FRAMEWORK_MAP } from "../lib/languageDetector";

// ---------------------------------------------------------------------------
// Extracted pure helpers (testable without Convex runtime)
// ---------------------------------------------------------------------------

/**
 * Map language to file extension.
 */
export function getExtension(language: string): string {
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

export interface BuildTDDPromptArgs {
  gherkin: string;
  label: string;
  framework: string;
  language: string;
  runner: string;
  configFile: string;
  repoMapText?: string;
  relevantChunksText?: string;
  existingTestExemplars?: string;
}

/**
 * Build the prompt for step definition generation.
 */
export function buildTDDPrompt(args: BuildTDDPromptArgs): string {
  const repoSection = args.repoMapText
    ? `## Repository Structure:\n${args.repoMapText}\n`
    : "";

  const codeSection = args.relevantChunksText
    ? `## Relevant Source Code:\n${args.relevantChunksText}\n`
    : "";

  const exemplarSection = args.existingTestExemplars
    ? `## Existing Test Code Style (match this project's conventions)
${args.existingTestExemplars}

Match the exact patterns above — same import style, same assertion library,
same naming conventions, same setup/teardown approach.
`
    : "";

  return `Generate executable step definitions for these Gherkin features.

## Target Framework: ${args.framework}
## Language: ${args.language}
## Test Runner: ${args.runner}
## Config File: ${args.configFile}

${repoSection}${codeSection}${exemplarSection}
## Gherkin Features (${args.label}):
${args.gherkin}

## Instructions
- Generate step definition files that implement each Given/When/Then step
- Reference actual module paths, function names, and types from the codebase
- Include necessary imports
- Use the ${args.framework} step definition syntax
- Generate test configuration file (${args.configFile})
- Include setup/teardown hooks if needed
- Step definitions should be in ${args.language}
- Group step definitions by feature file

CRITICAL: Every Given, When, Then, And, and But step in the Gherkin MUST have
a matching step definition. After generating, mentally verify that no steps
are unmatched. If a step needs a helper function that doesn't exist in the
codebase, generate it as a test utility.

Output as JSON:
{
  "files": [
    {"path": "tests/steps/feature_steps.${getExtension(args.language)}", "content": "..."},
    {"path": "tests/support/world.${getExtension(args.language)}", "content": "..."},
    {"path": "${args.configFile}", "content": "..."}
  ],
  "framework": "${args.framework}",
  "runCommand": "..."
}`;
}

/**
 * Parse TDD generation LLM response.
 */
export function parseTDDResponse(
  response: string,
  defaultFramework: string
): {
  stepDefs: string;
  framework: string;
} {
  try {
    const cleaned = response
      .replace(/^```json\n?/, "")
      .replace(/\n?```$/, "")
      .trim();
    const parsed = JSON.parse(cleaned);
    return {
      stepDefs: JSON.stringify(parsed.files || []),
      framework: parsed.framework || defaultFramework,
    };
  } catch {
    return { stepDefs: response, framework: defaultFramework };
  }
}

// ---------------------------------------------------------------------------
// Convex internalAction handler (thin wrapper)
// ---------------------------------------------------------------------------

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
    existingTestExemplars: v.optional(v.string()),
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
        const prompt = buildTDDPrompt({
          gherkin,
          label,
          framework: frameworkConfig.framework,
          language,
          runner: frameworkConfig.runner,
          configFile: frameworkConfig.configFile,
          repoMapText: repoMapText || undefined,
          relevantChunksText: relevantChunksText || undefined,
          existingTestExemplars: args.existingTestExemplars,
        });

        const response = await llm.chat(
          [
            { role: "system", content: prompt },
            {
              role: "user",
              content: "Generate the step definitions and test configuration.",
            },
          ],
          { temperature: 0.3, maxTokens: 10000 }
        );

        return parseTDDResponse(response, frameworkConfig.framework);
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
