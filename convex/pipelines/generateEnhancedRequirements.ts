"use node";

import Anthropic from "@anthropic-ai/sdk";
import { internalAction } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { createLLMClient } from "../lib/llm";
import {
  ANALYSIS_SYSTEM_PROMPT,
  parseAnalysisResponse,
} from "./analyzeRequirements";
import {
  extractAcceptanceCriteriaFromMarkdown,
  extractOpenQuestionsFromMarkdown,
} from "../generatedRequirements";

type RetrievedContext = {
  repoMapText?: string;
  productionChunks?: Array<{ filePath: string; content: string; score: number }>;
  relatedTestChunks?: Array<{ filePath: string; content: string; score: number }>;
  dependencySignatures?: string[];
  contextFiles?: Array<{ filenameOriginal: string; extractedText: string }>;
};

type DiscoveryPass = {
  summary: string;
  inScope: string[];
  outOfScope: string[];
  requirements: string[];
  acceptanceCriteria: string[];
  edgeCases: string[];
  failureModes: string[];
  repoSpecificNotes: string[];
  openQuestions: string[];
};

type EnhancedRequirementsDraft = {
  requirementsMarkdown: string;
  acceptanceCriteria: Array<{ id: string; text: string }>;
  openQuestions: string[];
  citationsJson?: string;
  reviewScoreJson?: string;
  llmProvider: string;
  llmModel: string;
};

function trimText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}\n...[truncated]` : value;
}

function buildDocumentBlock(title: string, text: string, cache = true): any {
  return {
    type: "document",
    title,
    source: {
      type: "text",
      media_type: "text/plain",
      data: Buffer.from(trimText(text, 60_000), "utf8").toString("base64"),
    },
    citations: { enabled: true },
    ...(cache ? { cache_control: { type: "ephemeral" } } : {}),
  };
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(
      raw.replace(/^```json\s*/, "").replace(/\s*```$/, "").trim(),
    ) as T;
  } catch {
    return fallback;
  }
}

function stringifyChunkList(
  chunks: Array<{ filePath: string; content: string; score?: number }>,
): string {
  return chunks
    .map((chunk) => {
      const scoreText = chunk.score !== undefined ? ` (score ${chunk.score.toFixed(2)})` : "";
      return `### ${chunk.filePath}${scoreText}\n${trimText(chunk.content, 8_000)}`;
    })
    .join("\n\n");
}

function buildFallbackPrompt(args: {
  sourceTitle: string;
  sourceBrief: string;
  context: RetrievedContext;
  currentDraft?: string;
}): string {
  return [
    "You are a senior software engineer expanding a software ticket into repo-grounded implementation requirements.",
    "Do not invent files, APIs, or behavior that are not supported by the provided repository evidence.",
    "",
    "<ticket>",
    `Title: ${args.sourceTitle}`,
    args.sourceBrief,
    "</ticket>",
    "",
    args.currentDraft ? `<current_draft>\n${args.currentDraft}\n</current_draft>\n` : "",
    "<repo_map>",
    args.context.repoMapText ?? "",
    "</repo_map>",
    "",
    "<code_chunks>",
    stringifyChunkList(args.context.productionChunks ?? []),
    "</code_chunks>",
    "",
    "<existing_tests>",
    stringifyChunkList(args.context.relatedTestChunks ?? []),
    "</existing_tests>",
    "",
    "<context_files>",
    (args.context.contextFiles ?? [])
      .map((file) => `### ${file.filenameOriginal}\n${trimText(file.extractedText, 8_000)}`)
      .join("\n\n"),
    "</context_files>",
    "",
    "<output_format>",
    "Return JSON with keys: requirementsMarkdown, acceptanceCriteria, openQuestions.",
    "requirementsMarkdown must include these sections in order:",
    "## Summary",
    "## In Scope",
    "## Out of Scope",
    "## Functional Requirements",
    "## Acceptance Criteria",
    "## Edge Cases",
    "## Failure Modes",
    "## Repo-Specific Notes",
    "## Open Questions",
    "acceptanceCriteria must be an array of objects: {\"id\":\"ER-AC-01\",\"text\":\"...\"}.",
    "</output_format>",
  ].join("\n");
}

function buildMarkdownFromDiscovery(discovery: DiscoveryPass): string {
  const renderList = (items: string[], ordered = false) =>
    items.length > 0
      ? items
          .map((item, index) => `${ordered ? `${index + 1}.` : "-"} ${item}`)
          .join("\n")
      : "- None identified from the available evidence.";

  return [
    "## Summary",
    discovery.summary || "No summary generated.",
    "",
    "## In Scope",
    renderList(discovery.inScope),
    "",
    "## Out of Scope",
    renderList(discovery.outOfScope),
    "",
    "## Functional Requirements",
    renderList(discovery.requirements),
    "",
    "## Acceptance Criteria",
    renderList(
      discovery.acceptanceCriteria.map((criterion, index) => `ER-AC-${String(index + 1).padStart(2, "0")}: ${criterion}`),
    ),
    "",
    "## Edge Cases",
    renderList(discovery.edgeCases),
    "",
    "## Failure Modes",
    renderList(discovery.failureModes),
    "",
    "## Repo-Specific Notes",
    renderList(discovery.repoSpecificNotes),
    "",
    "## Open Questions",
    renderList(discovery.openQuestions),
  ].join("\n");
}

function normalizeDraft(
  requirementsMarkdown: string,
  fallbackQuestions: string[],
  base: { citationsJson?: string; reviewScoreJson?: string; llmProvider: string; llmModel: string },
): EnhancedRequirementsDraft {
  const acceptanceCriteria = extractAcceptanceCriteriaFromMarkdown(requirementsMarkdown);
  const openQuestions = extractOpenQuestionsFromMarkdown(
    requirementsMarkdown,
    fallbackQuestions,
  );
  return {
    requirementsMarkdown,
    acceptanceCriteria,
    openQuestions,
    citationsJson: base.citationsJson,
    reviewScoreJson: base.reviewScoreJson,
    llmProvider: base.llmProvider,
    llmModel: base.llmModel,
  };
}

async function runAnthropicRequirementsGeneration(args: {
  sourceTitle: string;
  sourceBrief: string;
  context: RetrievedContext;
  currentDraft?: string;
}): Promise<{ draft: EnhancedRequirementsDraft; rawCitations?: string }> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is required for enhanced requirements generation");
  }

  const model = process.env.ENHANCED_REQUIREMENTS_MODEL || process.env.LLM_MODEL || "claude-sonnet-4-5-20250929";
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const staticBlocks = [
    buildDocumentBlock("Ticket", `Title: ${args.sourceTitle}\n\n${args.sourceBrief}`),
    buildDocumentBlock("Repository map", args.context.repoMapText || "No repository map available."),
    buildDocumentBlock(
      "Relevant production code",
      stringifyChunkList(args.context.productionChunks ?? []),
    ),
    buildDocumentBlock(
      "Related tests and specs",
      stringifyChunkList(args.context.relatedTestChunks ?? []),
    ),
    buildDocumentBlock(
      "Dependency signatures",
      (args.context.dependencySignatures ?? []).join("\n") || "No dependency signatures available.",
    ),
  ];

  if ((args.context.contextFiles ?? []).length > 0) {
    staticBlocks.push(
      buildDocumentBlock(
        "Repository context files",
        (args.context.contextFiles ?? [])
          .map((file) => `### ${file.filenameOriginal}\n${trimText(file.extractedText, 8_000)}`)
          .join("\n\n"),
      ),
    );
  }

  const discoveryPrompt = [
    "<instructions>",
    "Expand the ticket into repo-grounded engineering requirements.",
    "Only state behavior that is supported by the ticket and the evidence documents.",
    "Call out uncertainty explicitly under openQuestions.",
    "Return JSON with keys: summary, inScope, outOfScope, requirements, acceptanceCriteria, edgeCases, failureModes, repoSpecificNotes, openQuestions.",
    args.currentDraft ? "Treat the current draft as editor guidance, not source of truth." : "",
    "</instructions>",
    args.currentDraft ? `<current_draft>\n${args.currentDraft}\n</current_draft>` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const discoveryResponse: any = await client.messages.create({
    model,
    max_tokens: 4_000,
    temperature: 0.2,
    system:
      "You are a principal engineer writing precise software requirements from repository evidence.",
    messages: [
      {
        role: "user",
        content: [
          ...staticBlocks,
          {
            type: "text",
            text: discoveryPrompt,
          },
        ],
      },
    ],
  } as any);

  const discoveryText = (discoveryResponse.content ?? [])
    .filter((block: any) => block.type === "text")
    .map((block: any) => block.text)
    .join("\n");
  const citationsJson = JSON.stringify({
    staleAfterEdit: false,
    content: discoveryResponse.content ?? [],
    usage: discoveryResponse.usage ?? null,
  });
  const discovery = parseJson<DiscoveryPass>(discoveryText, {
    summary: "",
    inScope: [],
    outOfScope: [],
    requirements: [],
    acceptanceCriteria: [],
    edgeCases: [],
    failureModes: [],
    repoSpecificNotes: [],
    openQuestions: [],
  });
  const markdownSeed = buildMarkdownFromDiscovery(discovery);

  const draftingResponse: any = await client.messages.create({
    model,
    max_tokens: 5_000,
    temperature: 0.2,
    system:
      "You are a senior engineer producing a polished, editable requirements document. Preserve uncertainty and avoid invention.",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: [
              "<draft_seed>",
              markdownSeed,
              "</draft_seed>",
              "",
              "<output_format>",
              "Return JSON with keys requirementsMarkdown, acceptanceCriteria, openQuestions.",
              "requirementsMarkdown must preserve the exact sections from the seed.",
              "</output_format>",
            ].join("\n"),
          },
        ],
      },
    ],
  } as any);

  const draftingText = (draftingResponse.content ?? [])
    .filter((block: any) => block.type === "text")
    .map((block: any) => block.text)
    .join("\n");
  const drafted = parseJson<{
    requirementsMarkdown?: string;
    acceptanceCriteria?: Array<{ id: string; text: string }>;
    openQuestions?: string[];
  }>(draftingText, {});
  const requirementsMarkdown = drafted.requirementsMarkdown || markdownSeed;

  return {
    draft: normalizeDraft(
      requirementsMarkdown,
      discovery.openQuestions,
      {
        citationsJson,
        llmProvider: "anthropic",
        llmModel: model,
      },
    ),
    rawCitations: citationsJson,
  };
}

async function reviewDraftMarkdown(markdown: string): Promise<string | undefined> {
  const llm = createLLMClient(
    process.env.LLM_PROVIDER,
    process.env.LLM_MODEL,
    process.env.ANTHROPIC_API_KEY,
    process.env.OPENAI_API_KEY,
  );
  const response = await llm.chat(
    [
      { role: "system", content: ANALYSIS_SYSTEM_PROMPT },
      { role: "user", content: markdown },
    ],
    { temperature: 0.2, maxTokens: 2_000, responseFormat: "json" },
  );
  const parsed = parseAnalysisResponse(response);
  return JSON.stringify(parsed);
}

async function runFallbackRequirementsGeneration(args: {
  sourceTitle: string;
  sourceBrief: string;
  context: RetrievedContext;
  currentDraft?: string;
}): Promise<EnhancedRequirementsDraft> {
  const llm = createLLMClient(
    process.env.LLM_PROVIDER,
    process.env.LLM_MODEL,
    process.env.ANTHROPIC_API_KEY,
    process.env.OPENAI_API_KEY,
  );
  const response = await llm.chat(
    [
      {
        role: "system",
        content:
          "You are a senior engineer producing repo-grounded requirements. Return only valid JSON.",
      },
      {
        role: "user",
        content: buildFallbackPrompt(args),
      },
    ],
    { temperature: 0.2, maxTokens: 6_000 },
  );
  const parsed = parseJson<{
    requirementsMarkdown?: string;
    acceptanceCriteria?: Array<{ id: string; text: string }>;
    openQuestions?: string[];
  }>(response, {});
  const requirementsMarkdown =
    parsed.requirementsMarkdown ||
    buildMarkdownFromDiscovery({
      summary: "Fallback generation was used because Anthropic document mode was unavailable.",
      inScope: [],
      outOfScope: [],
      requirements: [],
      acceptanceCriteria: [],
      edgeCases: [],
      failureModes: [],
      repoSpecificNotes: [],
      openQuestions: [],
    });
  return normalizeDraft(
    requirementsMarkdown,
    parsed.openQuestions ?? [],
    {
      llmProvider: llm.provider,
      llmModel: llm.model,
    },
  );
}

export const generateEnhancedRequirements = internalAction({
  args: {
    bountyId: v.id("bounties"),
    conversationId: v.id("conversations"),
    sourceTitle: v.string(),
    sourceBrief: v.string(),
    repoContext: v.optional(v.string()),
    currentDraft: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.runMutation(internal.conversations.updateStatus, {
      conversationId: args.conversationId,
      status: "requirements_generation",
    });

    const parsedContext = args.repoContext
      ? parseJson<RetrievedContext>(args.repoContext, {})
      : {};

    let generated: EnhancedRequirementsDraft;
    try {
      generated = (await runAnthropicRequirementsGeneration({
        sourceTitle: args.sourceTitle,
        sourceBrief: args.sourceBrief,
        context: parsedContext,
        currentDraft: args.currentDraft,
      })).draft;
    } catch (error) {
      console.warn("Anthropic document generation failed, falling back:", error);
      generated = await runFallbackRequirementsGeneration({
        sourceTitle: args.sourceTitle,
        sourceBrief: args.sourceBrief,
        context: parsedContext,
        currentDraft: args.currentDraft,
      });
    }

    generated.reviewScoreJson = await reviewDraftMarkdown(
      generated.requirementsMarkdown,
    );

    const generatedRequirementId = await ctx.runMutation(
      internal.generatedRequirements.createOrReplaceDraft,
      {
        bountyId: args.bountyId,
        conversationId: args.conversationId,
        sourceTitle: args.sourceTitle,
        sourceBrief: args.sourceBrief,
        requirementsMarkdown: generated.requirementsMarkdown,
        acceptanceCriteria: generated.acceptanceCriteria,
        openQuestions: generated.openQuestions,
        citationsJson: generated.citationsJson,
        reviewScoreJson: generated.reviewScoreJson,
        llmProvider: generated.llmProvider,
        llmModel: generated.llmModel,
      },
    );

    await ctx.runMutation(internal.conversations.addMessage, {
      conversationId: args.conversationId,
      role: "assistant",
      content: JSON.stringify({
        type: "requirements_generated",
        generatedRequirementId,
        acceptanceCriteriaCount: generated.acceptanceCriteria.length,
        openQuestions: generated.openQuestions,
      }),
    });

    await ctx.runMutation(internal.conversations.updateStatus, {
      conversationId: args.conversationId,
      status: "requirements_review",
    });

    return {
      generatedRequirementId,
      ...generated,
    };
  },
});
