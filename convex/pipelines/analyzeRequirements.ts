import { internalAction } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { createLLMClient } from "../lib/llm";

// ---------------------------------------------------------------------------
// Extracted pure helpers (testable without Convex runtime)
// ---------------------------------------------------------------------------

export interface AnalysisResult {
  ready: boolean;
  scores?: Record<string, number>;
  extractedCriteria?: string[];
  questions?: Array<{
    question: string;
    reason: string;
    dimension?: string;
    options?: string[];
  }>;
  summary?: string;
}

export interface BuildAnalysisArgs {
  description: string;
  requirements?: string;
  repoContext?: string;
  previousMessages?: string;
}

/**
 * Build the user message content for requirements analysis.
 */
export function buildAnalysisUserContent(args: BuildAnalysisArgs): string {
  let content = `## Feature Request\n${args.description}`;

  if (args.requirements) {
    content += `\n\n## Additional Requirements\n${args.requirements}`;
  }

  if (args.repoContext) {
    content += `\n\n## Repository Context\n${args.repoContext}`;
  }

  if (args.previousMessages) {
    content += `\n\n## Previous Conversation\n${args.previousMessages}`;
  }

  return content;
}

/**
 * Parse analysis LLM response into structured result.
 */
export function parseAnalysisResponse(response: string): AnalysisResult {
  try {
    const cleaned = response
      .replace(/^```json\n?/, "")
      .replace(/\n?```$/, "")
      .trim();
    return JSON.parse(cleaned);
  } catch {
    return {
      ready: false,
      questions: [
        {
          question:
            "Could you provide more details about the expected behavior?",
          reason: "The requirements need more specificity for test generation",
        },
      ],
    };
  }
}

// ---------------------------------------------------------------------------
// System prompt (rubric-based)
// ---------------------------------------------------------------------------

const ANALYSIS_SYSTEM_PROMPT = `You are an expert BDD test architect. Analyze this feature request using the
8-dimension rubric below. Score each dimension 1-3 (1=unclear, 2=partial, 3=clear).

RUBRIC:
1. ACTORS: Are all user roles/system actors identified?
2. INPUTS: Are input fields, types, and valid ranges specified?
3. OUTPUTS: Are expected outputs/responses defined?
4. STATE PRECONDITIONS: Are required system states before the action clear?
5. ERROR HANDLING: Are failure modes and expected error behavior described?
6. EDGE CASES: Are boundary conditions or special cases mentioned?
7. INTEGRATION POINTS: Are external dependencies (DB, API, services) identified?
8. SECURITY CONSTRAINTS: Are auth/authz/validation requirements clear?

If average score >= 2.0, requirements are ready. Otherwise, ask targeted questions
for any dimension scoring 1.

ALWAYS include "extractedCriteria": a numbered list of every testable acceptance
criterion you can identify (even if inferred). These will be used to verify
coverage of the generated test suite.

Respond with JSON:
{
  "ready": boolean,
  "scores": {"actors": N, "inputs": N, "outputs": N, "statePreconditions": N, "errorHandling": N, "edgeCases": N, "integrationPoints": N, "securityConstraints": N},
  "extractedCriteria": ["Criterion 1: ...", "Criterion 2: ...", ...],
  "summary": "..." (if ready),
  "questions": [{"question": "...", "reason": "...", "dimension": "..."}] (if not ready)
}

Respond ONLY with valid JSON, no additional text.`;

// ---------------------------------------------------------------------------
// Convex internalAction handler (thin wrapper)
// ---------------------------------------------------------------------------

/**
 * Stage 1: Analyze requirements and detect ambiguity.
 * Determines if the bounty requirements are complete enough for test generation,
 * or if clarification questions are needed.
 */
export const analyzeRequirements = internalAction({
  args: {
    bountyId: v.id("bounties"),
    conversationId: v.id("conversations"),
    description: v.string(),
    requirements: v.optional(v.string()),
    repoContext: v.optional(v.string()),
    previousMessages: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<AnalysisResult> => {
    const llm = createLLMClient(
      process.env.LLM_PROVIDER,
      process.env.LLM_MODEL,
      process.env.ANTHROPIC_API_KEY,
      process.env.OPENAI_API_KEY
    );

    const userContent = buildAnalysisUserContent({
      description: args.description,
      requirements: args.requirements,
      repoContext: args.repoContext,
      previousMessages: args.previousMessages,
    });

    const response = await llm.chat(
      [
        { role: "system", content: ANALYSIS_SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
      { temperature: 0.3, maxTokens: 2000, responseFormat: "json" }
    );

    const result = parseAnalysisResponse(response);

    // Store the analysis as a conversation message
    await ctx.runMutation(internal.conversations.addMessage, {
      conversationId: args.conversationId,
      role: "assistant",
      content: JSON.stringify(result),
    });

    // Update conversation status
    if (result.ready) {
      await ctx.runMutation(internal.conversations.updateStatus, {
        conversationId: args.conversationId,
        status: "generating_bdd",
      });
    } else {
      await ctx.runMutation(internal.conversations.updateStatus, {
        conversationId: args.conversationId,
        status: "clarifying",
      });
    }

    return result;
  },
});
