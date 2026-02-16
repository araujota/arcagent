import { internalAction } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";

/**
 * Stage 2: Clarification loop.
 * Processes user answers to clarification questions and re-runs analysis.
 * Max 3 rounds of clarification before forcing generation.
 */
export const clarifyRequirements = internalAction({
  args: {
    bountyId: v.id("bounties"),
    conversationId: v.id("conversations"),
    description: v.string(),
    userAnswer: v.string(),
    repoContext: v.optional(v.string()),
    clarificationRound: v.number(),
  },
  handler: async (ctx, args) => {
    const MAX_ROUNDS = 3;

    // Store the user's answer
    await ctx.runMutation(internal.conversations.addMessage, {
      conversationId: args.conversationId,
      role: "user",
      content: args.userAnswer,
    });

    // Get conversation history
    const conversation = await ctx.runQuery(internal.conversations.getById, {
      conversationId: args.conversationId,
    });

    if (!conversation) {
      throw new Error("Conversation not found");
    }

    // If we've hit max rounds, proceed to generation
    if (args.clarificationRound >= MAX_ROUNDS) {
      await ctx.runMutation(internal.conversations.updateStatus, {
        conversationId: args.conversationId,
        status: "generating_bdd",
      });

      // Trigger BDD generation
      await ctx.scheduler.runAfter(0, internal.pipelines.generateBDD.generateBDD, {
        bountyId: args.bountyId,
        conversationId: args.conversationId,
        description: args.description,
        repoContext: args.repoContext,
      });

      return { proceed: true };
    }

    // Build conversation history string
    const messageHistory = conversation.messages
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n\n");

    // Re-run analysis with full context
    const result = await ctx.runAction(
      internal.pipelines.analyzeRequirements.analyzeRequirements,
      {
        bountyId: args.bountyId,
        conversationId: args.conversationId,
        description: args.description,
        repoContext: args.repoContext,
        previousMessages: messageHistory,
      }
    );

    if (result.ready) {
      // Trigger BDD generation with extracted criteria from analysis
      await ctx.scheduler.runAfter(0, internal.pipelines.generateBDD.generateBDD, {
        bountyId: args.bountyId,
        conversationId: args.conversationId,
        description: args.description,
        repoContext: args.repoContext,
        extractedCriteria: result.extractedCriteria,
      });
    }

    return result;
  },
});
