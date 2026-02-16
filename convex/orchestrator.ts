import { internalAction, action } from "./_generated/server";
import { v } from "convex/values";
import { internal, api } from "./_generated/api";

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

    // Fetch feature file exemplars from repo connection
    let existingFeatureExemplars: string | undefined;
    const repoConnection = await ctx.runQuery(api.repoConnections.getByBountyId, {
      bountyId: args.bountyId,
    });
    if (repoConnection?.detectedFeatureFiles && repoConnection.detectedFeatureFiles.length > 0) {
      existingFeatureExemplars = repoConnection.detectedFeatureFiles
        .slice(0, 2)
        .map((f: { filePath: string; content: string }) => `# ${f.filePath}\n${f.content}`)
        .join("\n\n");
    }

    const result = await ctx.runAction(
      internal.pipelines.generateBDD.generateBDD,
      {
        bountyId: args.bountyId,
        conversationId: args.conversationId,
        description: bounty.description,
        repoContext: conversation?.repoContextSnapshot || undefined,
        existingFeatureExemplars,
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

// ---------------------------------------------------------------------------
// Autonomous Pipeline (MCP bounty creation → full NL→BDD→TDD in one shot)
// ---------------------------------------------------------------------------

/**
 * Entry point for the autonomous pipeline.
 * Triggers repo fetching then schedules polling for repo readiness.
 */
export const runAutonomousPipeline = internalAction({
  args: {
    bountyId: v.id("bounties"),
    repoConnectionId: v.id("repoConnections"),
    conversationId: v.id("conversations"),
    repositoryUrl: v.string(),
  },
  handler: async (ctx, args) => {
    // Kick off the repo fetch pipeline
    await ctx.scheduler.runAfter(0, internal.pipelines.fetchRepo.fetchRepo, {
      repoConnectionId: args.repoConnectionId,
      bountyId: args.bountyId,
      repositoryUrl: args.repositoryUrl,
    });

    // Schedule polling for repo readiness
    await ctx.scheduler.runAfter(
      5000,
      internal.orchestrator.checkRepoAndStartGeneration,
      {
        bountyId: args.bountyId,
        repoConnectionId: args.repoConnectionId,
        conversationId: args.conversationId,
        attempt: 0,
      }
    );
  },
});

/**
 * Polls repoConnection status every 5s. When "ready", triggers generation.
 * Times out after 60 attempts (5 min).
 */
export const checkRepoAndStartGeneration = internalAction({
  args: {
    bountyId: v.id("bounties"),
    repoConnectionId: v.id("repoConnections"),
    conversationId: v.id("conversations"),
    attempt: v.number(),
  },
  handler: async (ctx, args) => {
    const maxAttempts = 60; // 5 min at 5s intervals

    const repoConnection = await ctx.runQuery(
      internal.repoConnections.getByBountyIdInternal,
      { bountyId: args.bountyId }
    );

    if (!repoConnection) {
      console.error(
        `[autonomous] Repo connection not found for bounty ${args.bountyId}`
      );
      return;
    }

    if (repoConnection.status === "ready") {
      // Repo is ready — start generation
      await ctx.scheduler.runAfter(
        0,
        internal.orchestrator.runAutonomousGeneration,
        {
          bountyId: args.bountyId,
          conversationId: args.conversationId,
        }
      );
      return;
    }

    if (repoConnection.status === "failed") {
      console.error(
        `[autonomous] Repo indexing failed for bounty ${args.bountyId}: ${repoConnection.errorMessage}`
      );
      await ctx.runMutation(internal.conversations.addMessage, {
        conversationId: args.conversationId,
        role: "system",
        content: `Repo indexing failed: ${repoConnection.errorMessage || "Unknown error"}`,
      });
      return;
    }

    if (args.attempt >= maxAttempts) {
      console.error(
        `[autonomous] Repo indexing timed out for bounty ${args.bountyId}`
      );
      await ctx.runMutation(internal.conversations.addMessage, {
        conversationId: args.conversationId,
        role: "system",
        content: "Repo indexing timed out after 5 minutes",
      });
      return;
    }

    // Still in progress — poll again in 5s
    await ctx.scheduler.runAfter(
      5000,
      internal.orchestrator.checkRepoAndStartGeneration,
      {
        bountyId: args.bountyId,
        repoConnectionId: args.repoConnectionId,
        conversationId: args.conversationId,
        attempt: args.attempt + 1,
      }
    );
  },
});

/**
 * Runs the full NL→BDD→TDD chain in one shot (autonomous mode).
 * No human interaction or clarification rounds.
 * Includes validateTests call with 1-retry regeneration loop.
 */
export const runAutonomousGeneration = internalAction({
  args: {
    bountyId: v.id("bounties"),
    conversationId: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    try {
      const bounty = await ctx.runQuery(internal.bounties.getByIdInternal, {
        bountyId: args.bountyId,
      });
      if (!bounty) throw new Error("Bounty not found");

      // 1. Retrieve repo context
      let repoContext: string | undefined;
      let parsedContext: { repoMapText?: string; relevantChunks?: Array<{ filePath: string; content: string }> } | null = null;
      try {
        const context = await ctx.runAction(
          internal.pipelines.retrieveContext.retrieveContext,
          {
            bountyId: args.bountyId,
            query: `${bounty.title}\n${bounty.description}`,
          }
        );
        repoContext = JSON.stringify(context);
        // Parse back to get typed access to relevantChunks
        try {
          parsedContext = JSON.parse(repoContext);
        } catch {
          // ignore parse failure
        }

        await ctx.runMutation(internal.conversations.updateRepoContext, {
          conversationId: args.conversationId,
          repoContextSnapshot: repoContext,
        });
      } catch (error) {
        console.warn("[autonomous] Failed to retrieve repo context:", error);
      }

      // 1b. Fetch feature file exemplars from repo connection
      const repoConnection = await ctx.runQuery(
        internal.repoConnections.getByBountyIdInternal,
        { bountyId: args.bountyId }
      );

      let existingFeatureExemplars: string | undefined;
      if (repoConnection?.detectedFeatureFiles && repoConnection.detectedFeatureFiles.length > 0) {
        existingFeatureExemplars = repoConnection.detectedFeatureFiles
          .slice(0, 2)
          .map((f: { filePath: string; content: string }) => `# ${f.filePath}\n${f.content}`)
          .join("\n\n");
      }

      // 1c. Extract test file exemplars from RAG chunks
      let existingTestExemplars: string | undefined;
      if (parsedContext?.relevantChunks) {
        const testChunks = parsedContext.relevantChunks
          .filter((c) => /\.(test|spec|steps)\./i.test(c.filePath))
          .slice(0, 3);
        if (testChunks.length > 0) {
          existingTestExemplars = testChunks
            .map((c) => `### ${c.filePath}\n${c.content}`)
            .join("\n\n");
        }
      }

      // 2. Run requirements analysis to extract criteria
      let extractedCriteria: string[] | undefined;
      try {
        const analysisResult = await ctx.runAction(
          internal.pipelines.analyzeRequirements.analyzeRequirements,
          {
            bountyId: args.bountyId,
            conversationId: args.conversationId,
            description: bounty.description,
            requirements: bounty.title,
            repoContext,
          }
        );
        extractedCriteria = analysisResult.extractedCriteria;
      } catch (error) {
        console.warn("[autonomous] Requirements analysis failed, continuing without criteria:", error);
      }

      // 3. Gather existing Gherkin from imported test suites as supplementary context
      let existingGherkin: string | undefined;
      const existingTestSuites = await ctx.runQuery(
        internal.testSuites.listAllByBounty,
        { bountyId: args.bountyId }
      );
      if (existingTestSuites && existingTestSuites.length > 0) {
        existingGherkin = existingTestSuites
          .map((ts) => ts.gherkinContent)
          .join("\n\n");
      }

      // 4. Generate BDD (creates the generatedTests record internally)
      await ctx.runAction(internal.pipelines.generateBDD.generateBDD, {
        bountyId: args.bountyId,
        conversationId: args.conversationId,
        description: bounty.description,
        repoContext,
        existingGherkin,
        existingFeatureExemplars,
        extractedCriteria,
      });

      // 5. Get the generated test record
      let generatedTest = await ctx.runQuery(
        internal.generatedTests.getByConversationIdInternal,
        { conversationId: args.conversationId }
      );
      if (!generatedTest) throw new Error("Generated test record not found after BDD generation");

      // 6. Auto-approve
      await ctx.runMutation(internal.generatedTests.updateStatus, {
        generatedTestId: generatedTest._id,
        status: "approved",
      });

      // 7. Generate TDD
      const conversation = await ctx.runQuery(
        internal.conversations.getById,
        { conversationId: args.conversationId }
      );

      const primaryLanguage = repoConnection?.languages?.[0] || "typescript";

      await ctx.runAction(internal.pipelines.generateTDD.generateTDD, {
        bountyId: args.bountyId,
        conversationId: args.conversationId,
        generatedTestId: generatedTest._id,
        gherkinPublic: generatedTest.gherkinPublic,
        gherkinHidden: generatedTest.gherkinHidden,
        repoContext: conversation?.repoContextSnapshot || undefined,
        primaryLanguage,
        existingTestExemplars,
      });

      // 8. Validate tests + 1-retry regeneration loop
      const updatedTestForValidation = await ctx.runQuery(
        internal.generatedTests.getByConversationIdInternal,
        { conversationId: args.conversationId }
      );

      if (updatedTestForValidation) {
        const validationResult = await ctx.runAction(
          internal.pipelines.validateTests.validateTests,
          {
            bountyId: args.bountyId,
            conversationId: args.conversationId,
            generatedTestId: generatedTest._id,
            gherkinPublic: updatedTestForValidation.gherkinPublic,
            gherkinHidden: updatedTestForValidation.gherkinHidden,
            stepDefinitions: updatedTestForValidation.stepDefinitions || "",
            extractedCriteria,
          }
        );

        // If validation indicates regeneration is needed, retry once
        if (validationResult.needsRegeneration) {
          console.log("[autonomous] Validation flagged gaps — retrying BDD generation");

          const gapDescription = [
            ...(validationResult.uncoveredCriteria || []).map(
              (c: string) => `Uncovered criterion: ${c}`
            ),
            ...(validationResult.parsedReview?.missingScenarios || []).map(
              (s: string) => `Missing scenario: ${s}`
            ),
          ].join("\n");

          const supplementaryPrompt = gapDescription
            ? `\n\nThe previous generation had coverage gaps. Please also cover:\n${gapDescription}`
            : "";

          // Re-generate BDD with gap info appended to description
          await ctx.runAction(internal.pipelines.generateBDD.generateBDD, {
            bountyId: args.bountyId,
            conversationId: args.conversationId,
            description: bounty.description + supplementaryPrompt,
            repoContext,
            existingGherkin,
            existingFeatureExemplars,
            extractedCriteria,
          });

          // Re-fetch and re-generate TDD
          const retryTest = await ctx.runQuery(
            internal.generatedTests.getByConversationIdInternal,
            { conversationId: args.conversationId }
          );
          if (retryTest) {
            generatedTest = retryTest;
            await ctx.runMutation(internal.generatedTests.updateStatus, {
              generatedTestId: retryTest._id,
              status: "approved",
            });
            await ctx.runAction(internal.pipelines.generateTDD.generateTDD, {
              bountyId: args.bountyId,
              conversationId: args.conversationId,
              generatedTestId: retryTest._id,
              gherkinPublic: retryTest.gherkinPublic,
              gherkinHidden: retryTest.gherkinHidden,
              repoContext: conversation?.repoContextSnapshot || undefined,
              primaryLanguage,
              existingTestExemplars,
            });
          }
        }
      }

      // 9. Mark as published
      await ctx.runMutation(internal.generatedTests.updateStatus, {
        generatedTestId: generatedTest._id,
        status: "published",
      });

      // 10. Create test suites (public + hidden)
      const finalTest = await ctx.runQuery(
        internal.generatedTests.getByConversationIdInternal,
        { conversationId: args.conversationId }
      );

      if (finalTest) {
        await ctx.runMutation(internal.testSuites.createInternal, {
          bountyId: args.bountyId,
          title: `${bounty.title} - Public Tests`,
          gherkinContent: finalTest.gherkinPublic,
          visibility: "public",
        });

        await ctx.runMutation(internal.testSuites.createInternal, {
          bountyId: args.bountyId,
          title: `${bounty.title} - Hidden Tests`,
          gherkinContent: finalTest.gherkinHidden,
          visibility: "hidden",
        });
      }

      // 11. Finalize conversation
      await ctx.runMutation(internal.conversations.updateStatus, {
        conversationId: args.conversationId,
        status: "finalized",
      });

      console.log(
        `[autonomous] Pipeline completed for bounty ${args.bountyId}`
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      console.error(
        `[autonomous] Pipeline failed for bounty ${args.bountyId}: ${errorMessage}`
      );

      await ctx.runMutation(internal.conversations.addMessage, {
        conversationId: args.conversationId,
        role: "system",
        content: `Autonomous pipeline failed: ${errorMessage}`,
      });

      // Reset conversation status to allow retry
      await ctx.runMutation(internal.conversations.updateStatus, {
        conversationId: args.conversationId,
        status: "gathering",
      });
    }
  },
});

/**
 * Retry a failed autonomous pipeline.
 * Can be called from MCP to re-trigger generation after a failure.
 */
export const retryAutonomousPipeline = internalAction({
  args: {
    bountyId: v.id("bounties"),
    conversationId: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const conversation = await ctx.runQuery(internal.conversations.getById, {
      conversationId: args.conversationId,
    });

    if (!conversation) {
      throw new Error("Conversation not found");
    }

    if (conversation.status !== "gathering") {
      throw new Error(
        `Cannot retry: conversation is in "${conversation.status}" state, expected "gathering"`
      );
    }

    await ctx.scheduler.runAfter(
      0,
      internal.orchestrator.runAutonomousGeneration,
      {
        bountyId: args.bountyId,
        conversationId: args.conversationId,
      }
    );
  },
});
