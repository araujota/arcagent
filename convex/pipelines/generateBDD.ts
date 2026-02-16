import { internalAction } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { createLLMClient } from "../lib/llm";
import { validateGherkin } from "../lib/gherkinValidator";

// ---------------------------------------------------------------------------
// Extracted pure helpers (testable without Convex runtime)
// ---------------------------------------------------------------------------

export interface BuildBDDSystemPromptArgs {
  description: string;
  repoMapText?: string;
  relevantChunksText?: string;
  existingGherkin?: string;
  existingFeatureExemplars?: string;
  conversationHistory?: string;
  extractedCriteria?: string[];
}

/**
 * Build the full system prompt for BDD generation.
 * Uses a 3-phase chain-of-thought: Analysis → Coverage Taxonomy → Gherkin.
 */
export function buildBDDSystemPrompt(args: BuildBDDSystemPromptArgs): string {
  const repoSection = args.repoMapText
    ? `## Repository Structure\n${args.repoMapText}\n`
    : "";

  const codeSection = args.relevantChunksText
    ? `## Relevant Code\n${args.relevantChunksText}\n`
    : "";

  const existingGherkinSection = args.existingGherkin
    ? `## Existing Test Scenarios
The repository already has these BDD scenarios. Generate ADDITIONAL scenarios
that complement these, covering cases they miss. Do NOT duplicate existing scenarios.

${args.existingGherkin}
`
    : "";

  const exemplarSection = args.existingFeatureExemplars
    ? `## Style Reference (match this project's Gherkin conventions)
${args.existingFeatureExemplars}

Match the exact style above — same step phrasing patterns, same tag conventions,
same Background usage, same Scenario Outline structure.
`
    : "";

  const conversationSection = args.conversationHistory
    ? `## Clarification Answers\n${args.conversationHistory}\n`
    : "";

  const criteriaSection =
    args.extractedCriteria && args.extractedCriteria.length > 0
      ? `## Extracted Acceptance Criteria (ALL must be covered by at least one scenario)
${args.extractedCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}
`
      : "";

  return `You are an expert BDD test architect. Generate comprehensive Gherkin feature files for this feature request.

${repoSection}${codeSection}${existingGherkinSection}${exemplarSection}
## Feature Request
${args.description}

${conversationSection}${criteriaSection}
## Instructions — 3-Phase Chain-of-Thought

### Phase 1 — ANALYSIS (think step-by-step before writing Gherkin)
Before generating any Gherkin, produce an analysis object:
- List all actors/roles involved
- Enumerate all inputs and their valid/invalid ranges
- Identify all system states and transitions
- List all external dependencies that could fail
- Extract testable acceptance criteria as a numbered list

### Phase 2 — COVERAGE TAXONOMY (generate scenarios organized by category)

PUBLIC scenarios must cover ALL of these categories:
1. HAPPY PATH: Primary success flow(s) — at least 2 scenarios
2. INPUT VALIDATION: Required fields missing, wrong types, malformed data — at least 2
3. ERROR HANDLING: Each failure mode the system should handle gracefully — at least 2
4. API CONTRACTS: Expected request/response shapes, status codes, headers
5. STATE TRANSITIONS: Valid and invalid transitions between system states

HIDDEN scenarios must cover ALL of these categories:
6. BOUNDARY VALUES: For each input — min valid, max valid, one below, one above, zero/empty
7. EQUIVALENCE PARTITIONS: Group inputs into classes, test one from each valid/invalid class
8. SECURITY: Injection attempts, unauthorized access, data boundary violations
9. CONCURRENCY: Simultaneous operations on the same resource (if applicable)
10. ANTI-GAMING: Tests that catch hardcoded solutions:
    - Use Scenario Outline with diverse Examples (not just 1-2 rows)
    - Include property-based assertions (e.g., output length == input count)
    - Include metamorphic checks (renamed vars, scaled inputs → same behavior)

### Phase 3 — GENERATE GHERKIN following these rules:
- Use Background for shared setup across scenarios
- Use Scenario Outline + Examples for parameterized tests (minimum 4 example rows)
- Tag every scenario: @public/@hidden + @happy-path/@validation/@error/@boundary/@security/@anti-gaming
- Each Feature must have a description paragraph
- Minimum: 8 public scenarios, 8 hidden scenarios

## Output Format
Respond with JSON:
{
  "analysis": {
    "actors": ["..."],
    "inputs": ["..."],
    "states": ["..."],
    "dependencies": ["..."],
    "criteria": ["..."]
  },
  "public": "Feature: ...\\n  Scenario: ...\\n    Given ...\\n    When ...\\n    Then ...",
  "hidden": "Feature: ...\\n  Scenario: ...\\n    Given ...\\n    When ...\\n    Then ..."
}`;
}

/**
 * Parse BDD generation LLM response into public/hidden Gherkin + analysis.
 */
export function parseBDDResponse(response: string): {
  public: string;
  hidden: string;
  analysis?: {
    actors?: string[];
    inputs?: string[];
    states?: string[];
    dependencies?: string[];
    criteria?: string[];
  };
} {
  // Try JSON parse first
  try {
    const cleaned = response
      .replace(/^```json\n?/, "")
      .replace(/\n?```$/, "")
      .trim();
    const parsed = JSON.parse(cleaned);
    return {
      public: parsed.public || "",
      hidden: parsed.hidden || "",
      analysis: parsed.analysis,
    };
  } catch {
    // Fallback: split on delimiter
    const parts = response.split(/---\s*HIDDEN\s*---/i);
    const gherkinPublic =
      parts[0]
        ?.replace(/^```gherkin\n?/, "")
        .replace(/\n?```$/, "")
        .trim() || "";
    const gherkinHidden = (parts[1] || "")
      .replace(/^```gherkin\n?/, "")
      .replace(/\n?```$/, "")
      .trim();

    return {
      public: gherkinPublic,
      hidden: gherkinHidden,
    };
  }
}

// ---------------------------------------------------------------------------
// Convex internalAction handler (thin wrapper)
// ---------------------------------------------------------------------------

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
    existingGherkin: v.optional(v.string()),
    existingFeatureExemplars: v.optional(v.string()),
    extractedCriteria: v.optional(v.array(v.string())),
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

      const systemPrompt = buildBDDSystemPrompt({
        description: args.description,
        repoMapText,
        relevantChunksText,
        existingGherkin: args.existingGherkin,
        existingFeatureExemplars: args.existingFeatureExemplars,
        conversationHistory,
        extractedCriteria: args.extractedCriteria,
      });

      const response = await llm.chat(
        [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: "Generate the Gherkin test specifications.",
          },
        ],
        { temperature: 0.25, maxTokens: 12000 }
      );

      // Parse the response
      const parsed = parseBDDResponse(response);
      const gherkinPublic = parsed.public;
      const gherkinHidden = parsed.hidden;

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

      // Post-parse scenario count check
      if (publicValidation.stats.scenarios < 8) {
        console.warn(
          `Public Gherkin has only ${publicValidation.stats.scenarios} scenarios (target: 8+)`
        );
      }
      if (hiddenValidation.stats.scenarios < 8) {
        console.warn(
          `Hidden Gherkin has only ${hiddenValidation.stats.scenarios} scenarios (target: 8+)`
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
          analysis: parsed.analysis,
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

      // Store generated tests — upsert to avoid orphan records on retry
      const existing = await ctx.runQuery(
        internal.generatedTests.getByConversationIdInternal,
        { conversationId: args.conversationId }
      );

      if (existing) {
        await ctx.runMutation(internal.generatedTests.updateGherkinInternal, {
          generatedTestId: existing._id,
          gherkinPublic,
          gherkinHidden,
        });
      } else {
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
      }

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
