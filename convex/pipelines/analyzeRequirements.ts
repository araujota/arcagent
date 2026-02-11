import { internalAction } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { createLLMClient } from "../lib/llm";

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
  handler: async (ctx, args): Promise<{
    ready: boolean;
    questions?: Array<{
      question: string;
      reason: string;
      options?: string[];
    }>;
    summary?: string;
  }> => {
    const llm = createLLMClient(
      process.env.LLM_PROVIDER,
      process.env.LLM_MODEL,
      process.env.ANTHROPIC_API_KEY,
      process.env.OPENAI_API_KEY
    );

    const systemPrompt = `You are an expert BDD test architect. Analyze this feature request and the connected codebase. Determine if the requirements are complete enough to generate comprehensive Gherkin test specifications.

Consider:
- Are acceptance criteria explicit or implied?
- Are edge cases addressed?
- Are error handling expectations defined?
- Does the codebase context reveal integration points that need testing?
- Are there ambiguous terms that could be interpreted multiple ways?

If the requirements are clear, respond with JSON: {"ready": true, "summary": "Brief summary of what will be tested"}
If clarification is needed, respond with JSON: {"ready": false, "questions": [{"question": "...", "reason": "Why this matters", "options": ["option1", "option2"]}]}

Respond ONLY with valid JSON, no additional text.`;

    let userContent = `## Feature Request\n${args.description}`;

    if (args.requirements) {
      userContent += `\n\n## Additional Requirements\n${args.requirements}`;
    }

    if (args.repoContext) {
      userContent += `\n\n## Repository Context\n${args.repoContext}`;
    }

    if (args.previousMessages) {
      userContent += `\n\n## Previous Conversation\n${args.previousMessages}`;
    }

    const response = await llm.chat(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      { temperature: 0.3, maxTokens: 2000, responseFormat: "json" }
    );

    // Parse the response
    let result: {
      ready: boolean;
      questions?: Array<{
        question: string;
        reason: string;
        options?: string[];
      }>;
      summary?: string;
    };

    try {
      // Strip markdown code fences if present
      const cleaned = response
        .replace(/^```json\n?/, "")
        .replace(/\n?```$/, "")
        .trim();
      result = JSON.parse(cleaned);
    } catch {
      // If parsing fails, assume we need clarification
      result = {
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
