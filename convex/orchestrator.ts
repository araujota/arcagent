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

type ParsedRepoContext = {
  repoMapText?: string;
  relevantChunks?: Array<{ filePath: string; content: string }>;
} | null;

function parseRepoContextSnapshot(repoContext?: string): ParsedRepoContext {
  if (!repoContext) return null;
  try {
    return JSON.parse(repoContext) as ParsedRepoContext;
  } catch {
    return null;
  }
}

function getExistingFeatureExemplars(repoConnection: {
  detectedFeatureFiles?: Array<{ filePath: string; content: string }>;
} | null): string | undefined {
  if (!repoConnection?.detectedFeatureFiles || repoConnection.detectedFeatureFiles.length === 0) {
    return undefined;
  }
  return repoConnection.detectedFeatureFiles
    .slice(0, 2)
    .map((file) => `# ${file.filePath}\n${file.content}`)
    .join("\n\n");
}

function getExistingTestExemplars(parsedContext: ParsedRepoContext): string | undefined {
  const relevantChunks = parsedContext?.relevantChunks;
  if (!relevantChunks) return undefined;
  const testChunks = relevantChunks
    .filter((chunk) => /\.(test|spec|steps)\./i.test(chunk.filePath))
    .slice(0, 3);
  if (testChunks.length === 0) return undefined;
  return testChunks
    .map((chunk) => `### ${chunk.filePath}\n${chunk.content}`)
    .join("\n\n");
}

async function resolveRepoContextSnapshot(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  args: { bountyId: any; conversationId: any },
  bounty: { title: string; description: string },
): Promise<{ repoContext?: string; parsedContext: ParsedRepoContext }> {
  let repoContext: string | undefined;
  try {
    const context = await ctx.runAction(
      internal.pipelines.retrieveContext.retrieveContext,
      {
        bountyId: args.bountyId,
        query: `${bounty.title}\n${bounty.description}`,
      },
    );
    repoContext = JSON.stringify(context);
    await ctx.runMutation(internal.conversations.updateRepoContext, {
      conversationId: args.conversationId,
      repoContextSnapshot: repoContext,
    });
  } catch (error) {
    console.warn("[autonomous] Failed to retrieve repo context:", error);
  }
  return {
    repoContext,
    parsedContext: parseRepoContextSnapshot(repoContext),
  };
}

async function resolveExtractedCriteria(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  args: { bountyId: any; conversationId: any },
  bounty: { title: string; description: string },
  repoContext?: string,
): Promise<string[] | undefined> {
  try {
    const analysisResult = await ctx.runAction(
      internal.pipelines.analyzeRequirements.analyzeRequirements,
      {
        bountyId: args.bountyId,
        conversationId: args.conversationId,
        description: bounty.description,
        requirements: bounty.title,
        repoContext,
      },
    );
    return analysisResult.extractedCriteria;
  } catch (error) {
    console.warn("[autonomous] Requirements analysis failed, continuing without criteria:", error);
    return undefined;
  }
}

async function resolveExistingGherkin(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  bountyId: any,
): Promise<string | undefined> {
  const existingTestSuites = await ctx.runQuery(
    internal.testSuites.listAllByBounty,
    { bountyId },
  );
  if (!existingTestSuites || existingTestSuites.length === 0) {
    return undefined;
  }
  return existingTestSuites
    .map((testSuite: { gherkinContent: string }) => testSuite.gherkinContent)
    .join("\n\n");
}

async function loadGeneratedTestOrThrow(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  conversationId: any,
  errorMessage: string,
): Promise<any> {
  const generatedTest = await ctx.runQuery(
    internal.generatedTests.getByConversationIdInternal,
    { conversationId },
  );
  if (!generatedTest) {
    throw new Error(errorMessage);
  }
  return generatedTest;
}

async function runBDDGeneration(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  args: { bountyId: any; conversationId: any },
  description: string,
  options: {
    repoContext?: string;
    existingGherkin?: string;
    existingFeatureExemplars?: string;
    extractedCriteria?: string[];
  },
): Promise<void> {
  await ctx.runAction(internal.pipelines.generateBDD.generateBDD, {
    bountyId: args.bountyId,
    conversationId: args.conversationId,
    description,
    repoContext: options.repoContext,
    existingGherkin: options.existingGherkin,
    existingFeatureExemplars: options.existingFeatureExemplars,
    extractedCriteria: options.extractedCriteria,
  });
}

async function runTDDGeneration(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  args: { bountyId: any; conversationId: any },
  generatedTest: any,
  repoContextSnapshot: string | undefined,
  primaryLanguage: string,
  existingTestExemplars?: string,
): Promise<void> {
  await ctx.runAction(internal.pipelines.generateTDD.generateTDD, {
    bountyId: args.bountyId,
    conversationId: args.conversationId,
    generatedTestId: generatedTest._id,
    gherkinPublic: generatedTest.gherkinPublic,
    gherkinHidden: generatedTest.gherkinHidden,
    repoContext: repoContextSnapshot,
    primaryLanguage,
    existingTestExemplars,
  });
}

async function runValidation(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  args: { bountyId: any; conversationId: any },
  generatedTest: any,
  extractedCriteria?: string[],
): Promise<any> {
  return await ctx.runAction(
    internal.pipelines.validateTests.validateTests,
    {
      bountyId: args.bountyId,
      conversationId: args.conversationId,
      generatedTestId: generatedTest._id,
      gherkinPublic: generatedTest.gherkinPublic,
      gherkinHidden: generatedTest.gherkinHidden,
      stepDefinitions: generatedTest.stepDefinitions || "",
      stepDefinitionsPublic: generatedTest.stepDefinitionsPublic || undefined,
      stepDefinitionsHidden: generatedTest.stepDefinitionsHidden || undefined,
      extractedCriteria,
    },
  );
}

function buildValidationIssueSummary(validationResult: any): string {
  return [
    ...(validationResult.issues ?? []),
    ...(validationResult.uncoveredCriteria ?? []).map(
      (criterion: string) => `Uncovered criterion: ${criterion}`,
    ),
    ...(validationResult.parsedReview?.missingScenarios ?? []).map(
      (scenario: string) => `Missing scenario: ${scenario}`,
    ),
  ]
    .filter(Boolean)
    .slice(0, 10)
    .join("; ");
}

function buildValidationGapDescription(validationResult: any): string {
  return [
    ...(validationResult.uncoveredCriteria || []).map(
      (criterion: string) => `Uncovered criterion: ${criterion}`,
    ),
    ...(validationResult.parsedReview?.missingScenarios || []).map(
      (scenario: string) => `Missing scenario: ${scenario}`,
    ),
    ...(validationResult.issues || []).map((issue: string) => `Validation issue: ${issue}`),
  ].join("\n");
}

function buildSupplementaryPrompt(gapDescription: string): string {
  if (!gapDescription) return "";
  return `\n\nThe previous generation had quality gaps. Please also cover:\n${gapDescription}`;
}

async function validateWithSingleRetry(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  args: { bountyId: any; conversationId: any },
  bounty: { description: string },
  options: {
    repoContext?: string;
    existingGherkin?: string;
    existingFeatureExemplars?: string;
    extractedCriteria?: string[];
    repoContextSnapshot?: string;
    primaryLanguage: string;
    existingTestExemplars?: string;
  },
): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const generatedTest = await loadGeneratedTestOrThrow(
      ctx,
      args.conversationId,
      "Generated test record missing before validation",
    );
    const validationResult = await runValidation(
      ctx,
      args,
      generatedTest,
      options.extractedCriteria,
    );
    if (!validationResult.needsRegeneration && validationResult.valid) {
      return;
    }
    if (attempt === 2) {
      const issueSummary = buildValidationIssueSummary(validationResult);
      throw new Error(
        `Generated tests failed quality gates after retry${issueSummary ? `: ${issueSummary}` : ""}`,
      );
    }

    console.log("[autonomous] Validation flagged gaps — retrying BDD/TDD generation");
    const supplementaryPrompt = buildSupplementaryPrompt(
      buildValidationGapDescription(validationResult),
    );
    await runBDDGeneration(ctx, args, bounty.description + supplementaryPrompt, {
      repoContext: options.repoContext,
      existingGherkin: options.existingGherkin,
      existingFeatureExemplars: options.existingFeatureExemplars,
      extractedCriteria: options.extractedCriteria,
    });
    const retryTest = await loadGeneratedTestOrThrow(
      ctx,
      args.conversationId,
      "Generated test record missing after regeneration",
    );
    await ctx.runMutation(internal.generatedTests.updateStatus, {
      generatedTestId: retryTest._id,
      status: "approved",
    });
    await runTDDGeneration(
      ctx,
      args,
      retryTest,
      options.repoContextSnapshot,
      options.primaryLanguage,
      options.existingTestExemplars,
    );
  }
}

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

      const { repoContext, parsedContext } = await resolveRepoContextSnapshot(
        ctx,
        args,
        bounty,
      );
      const repoConnection = await ctx.runQuery(
        internal.repoConnections.getByBountyIdInternal,
        { bountyId: args.bountyId },
      );
      const existingFeatureExemplars = getExistingFeatureExemplars(repoConnection);
      const existingTestExemplars = getExistingTestExemplars(parsedContext);
      const extractedCriteria = await resolveExtractedCriteria(
        ctx,
        args,
        bounty,
        repoContext,
      );
      const existingGherkin = await resolveExistingGherkin(ctx, args.bountyId);

      await runBDDGeneration(ctx, args, bounty.description, {
        repoContext,
        existingGherkin,
        existingFeatureExemplars,
        extractedCriteria,
      });

      const generatedTest = await loadGeneratedTestOrThrow(
        ctx,
        args.conversationId,
        "Generated test record not found after BDD generation",
      );
      await ctx.runMutation(internal.generatedTests.updateStatus, {
        generatedTestId: generatedTest._id,
        status: "approved",
      });

      const conversation = await ctx.runQuery(
        internal.conversations.getById,
        { conversationId: args.conversationId },
      );
      const primaryLanguage = repoConnection?.languages?.[0] || "typescript";
      await runTDDGeneration(
        ctx,
        args,
        generatedTest,
        conversation?.repoContextSnapshot || undefined,
        primaryLanguage,
        existingTestExemplars,
      );
      await validateWithSingleRetry(ctx, args, bounty, {
        repoContext,
        existingGherkin,
        existingFeatureExemplars,
        extractedCriteria,
        repoContextSnapshot: conversation?.repoContextSnapshot || undefined,
        primaryLanguage,
        existingTestExemplars,
      });

      const finalTest = await loadGeneratedTestOrThrow(
        ctx,
        args.conversationId,
        "Generated tests did not pass quality gates",
      );
      await ctx.runMutation(internal.generatedTests.updateStatus, {
        generatedTestId: finalTest._id,
        status: "published",
      });
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
