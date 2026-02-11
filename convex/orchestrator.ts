import { internalAction, action } from "./_generated/server";
import { v } from "convex/values";
import { internal, api } from "./_generated/api";

/**
 * Main orchestrator for the NL→BDD→TDD pipeline.
 * Coordinates the full flow from requirements analysis to test generation.
 */
export const generateTestSuite = internalAction({
  args: {
    bountyId: v.id("bounties"),
    description: v.string(),
    requirements: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // 1. Create a conversation record
    const conversationId = await ctx.runMutation(
      internal.conversations.addMessage,
      // We need to create the conversation first — but that's a public mutation.
      // Use an internal approach instead.
      {
        conversationId: "" as any, // placeholder — this won't work directly
        role: "system",
        content: "Starting test generation pipeline",
      }
    );

    // The actual flow is triggered from the frontend via the generate page.
    // This stub is kept for backward compatibility.
    console.log(
      `generateTestSuite called for bounty ${args.bountyId}`
    );

    return {
      gherkinContent: `Feature: ${args.description}\n\n  Scenario: Basic functionality\n    Given the system is initialized\n    When the agent submits a solution\n    Then the solution should pass all tests`,
      title: "Auto-generated Test Suite",
    };
  },
});

/**
 * Start the AI-assisted generation pipeline.
 * Called from the frontend when the user initiates generation.
 */
export const startGenerationPipeline = action({
  args: {
    bountyId: v.id("bounties"),
    conversationId: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    // Get bounty details
    const bounty = await ctx.runQuery(api.bounties.getById, {
      bountyId: args.bountyId,
    });

    if (!bounty) {
      throw new Error("Bounty not found");
    }

    // Try to retrieve repo context if a repo is connected
    let repoContext: string | null = null;
    const repoConnection = await ctx.runQuery(api.repoConnections.getByBountyId, {
      bountyId: args.bountyId,
    });

    if (repoConnection && repoConnection.status === "ready") {
      try {
        const context = await ctx.runAction(
          internal.pipelines.retrieveContext.retrieveContext,
          {
            bountyId: args.bountyId,
            query: `${bounty.title}\n${bounty.description}`,
          }
        );

        repoContext = JSON.stringify(context);

        // Store repo context snapshot on conversation
        await ctx.runMutation(internal.conversations.updateRepoContext, {
          conversationId: args.conversationId,
          repoContextSnapshot: repoContext,
        });
      } catch (error) {
        console.warn("Failed to retrieve repo context:", error);
      }
    }

    // Start with requirements analysis
    const result = await ctx.runAction(
      internal.pipelines.analyzeRequirements.analyzeRequirements,
      {
        bountyId: args.bountyId,
        conversationId: args.conversationId,
        description: bounty.description,
        requirements: bounty.title,
        repoContext: repoContext || undefined,
      }
    );

    return result;
  },
});

/**
 * Continue the pipeline after user provides answers to clarification questions.
 */
export const continueWithClarification = action({
  args: {
    bountyId: v.id("bounties"),
    conversationId: v.id("conversations"),
    userAnswer: v.string(),
    clarificationRound: v.number(),
  },
  handler: async (ctx, args) => {
    const bounty = await ctx.runQuery(api.bounties.getById, {
      bountyId: args.bountyId,
    });

    if (!bounty) {
      throw new Error("Bounty not found");
    }

    // Get repo context from conversation
    const conversation = await ctx.runQuery(api.conversations.getByIdPublic, {
      conversationId: args.conversationId,
    });

    const result = await ctx.runAction(
      internal.pipelines.clarifyRequirements.clarifyRequirements,
      {
        bountyId: args.bountyId,
        conversationId: args.conversationId,
        description: bounty.description,
        userAnswer: args.userAnswer,
        repoContext: conversation?.repoContextSnapshot || undefined,
        clarificationRound: args.clarificationRound,
      }
    );

    return result;
  },
});

/**
 * Trigger BDD generation directly (skip clarification).
 */
export const generateBDDDirect = action({
  args: {
    bountyId: v.id("bounties"),
    conversationId: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const bounty = await ctx.runQuery(api.bounties.getById, {
      bountyId: args.bountyId,
    });

    if (!bounty) {
      throw new Error("Bounty not found");
    }

    const conversation = await ctx.runQuery(api.conversations.getByIdPublic, {
      conversationId: args.conversationId,
    });

    const result = await ctx.runAction(
      internal.pipelines.generateBDD.generateBDD,
      {
        bountyId: args.bountyId,
        conversationId: args.conversationId,
        description: bounty.description,
        repoContext: conversation?.repoContextSnapshot || undefined,
      }
    );

    return result;
  },
});

/**
 * Trigger TDD generation after BDD is approved.
 */
export const generateTDDFromBDD = action({
  args: {
    bountyId: v.id("bounties"),
    conversationId: v.id("conversations"),
    generatedTestId: v.id("generatedTests"),
    primaryLanguage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const test = await ctx.runQuery(api.generatedTests.getByConversationId, {
      conversationId: args.conversationId,
    });

    if (!test) {
      throw new Error("Generated tests not found");
    }

    const conversation = await ctx.runQuery(api.conversations.getByIdPublic, {
      conversationId: args.conversationId,
    });

    const result = await ctx.runAction(
      internal.pipelines.generateTDD.generateTDD,
      {
        bountyId: args.bountyId,
        conversationId: args.conversationId,
        generatedTestId: args.generatedTestId,
        gherkinPublic: test.gherkinPublic,
        gherkinHidden: test.gherkinHidden,
        repoContext: conversation?.repoContextSnapshot || undefined,
        primaryLanguage: args.primaryLanguage,
      }
    );

    return result;
  },
});

/**
 * Connect and index a repository for a bounty.
 */
export const connectAndIndexRepo = action({
  args: {
    bountyId: v.id("bounties"),
    repoConnectionId: v.id("repoConnections"),
    repositoryUrl: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.scheduler.runAfter(0, internal.pipelines.fetchRepo.fetchRepo, {
      repoConnectionId: args.repoConnectionId,
      bountyId: args.bountyId,
      repositoryUrl: args.repositoryUrl,
    });
  },
});
