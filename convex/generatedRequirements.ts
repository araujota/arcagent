import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { v } from "convex/values";
import { getCurrentUser, requireAuth, requireBountyAccess } from "./lib/utils";

type Criterion = {
  id: string;
  text: string;
};

function buildStableCriterionId(index: number): string {
  return `ER-AC-${String(index + 1).padStart(2, "0")}`;
}

function sliceMarkdownSection(markdown: string, heading: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim().toLowerCase() === `## ${heading}`.toLowerCase());
  if (start === -1) return "";
  const collected: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].trim().startsWith("## ")) break;
    collected.push(lines[index]);
  }
  return collected.join("\n").trim();
}

function parseBulletLines(section: string): string[] {
  return section
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[-*]\s+/, "").replace(/^\d+\.\s+/, ""))
    .filter(Boolean);
}

export function extractAcceptanceCriteriaFromMarkdown(
  markdown: string,
  fallback: Criterion[] = [],
): Criterion[] {
  const section = sliceMarkdownSection(markdown, "Acceptance Criteria");
  const parsed = parseBulletLines(section);
  if (parsed.length === 0) return fallback;

  return parsed.map((line, index) => {
    const explicit = line.match(/^(ER-AC-\d{2})[:\s-]+(.+)$/i);
    return explicit
      ? {
          id: explicit[1].toUpperCase(),
          text: explicit[2].trim(),
        }
      : {
          id: buildStableCriterionId(index),
          text: line,
        };
  });
}

export function extractOpenQuestionsFromMarkdown(
  markdown: string,
  fallback: string[] = [],
): string[] {
  const section = sliceMarkdownSection(markdown, "Open Questions");
  const parsed = parseBulletLines(section);
  return parsed.length > 0 ? parsed : fallback;
}

function markCitationsStale(citationsJson?: string): string | undefined {
  if (!citationsJson) {
    return JSON.stringify({ staleAfterEdit: true, items: [] });
  }
  try {
    const parsed = JSON.parse(citationsJson);
    return JSON.stringify({
      ...parsed,
      staleAfterEdit: true,
    });
  } catch {
    return JSON.stringify({
      staleAfterEdit: true,
      raw: citationsJson,
    });
  }
}

export const getByBountyId = query({
  args: { bountyId: v.id("bounties") },
  handler: async (ctx, args) => {
    await requireBountyAccess(ctx, args.bountyId);
    return await ctx.db
      .query("generatedRequirements")
      .withIndex("by_bountyId", (q) => q.eq("bountyId", args.bountyId))
      .order("desc")
      .first();
  },
});

export const getByConversationId = query({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) return null;
    await requireBountyAccess(ctx, conversation.bountyId);
    return await ctx.db
      .query("generatedRequirements")
      .withIndex("by_conversationId", (q) => q.eq("conversationId", args.conversationId))
      .order("desc")
      .first();
  },
});

export const getApprovedByBountyId = query({
  args: { bountyId: v.id("bounties") },
  handler: async (ctx, args) => {
    await requireBountyAccess(ctx, args.bountyId);
    const rows = await ctx.db
      .query("generatedRequirements")
      .withIndex("by_bountyId", (q) => q.eq("bountyId", args.bountyId))
      .collect();
    return rows
      .filter((row) => row.status === "approved")
      .sort((a, b) => b.version - a.version)[0] ?? null;
  },
});

export const getByBountyIdInternal = internalQuery({
  args: { bountyId: v.id("bounties") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("generatedRequirements")
      .withIndex("by_bountyId", (q) => q.eq("bountyId", args.bountyId))
      .order("desc")
      .first();
  },
});

export const getApprovedByBountyIdInternal = internalQuery({
  args: { bountyId: v.id("bounties") },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("generatedRequirements")
      .withIndex("by_bountyId", (q) => q.eq("bountyId", args.bountyId))
      .collect();
    return rows
      .filter((row) => row.status === "approved")
      .sort((a, b) => b.version - a.version)[0] ?? null;
  },
});

export const createOrReplaceDraft = internalMutation({
  args: {
    bountyId: v.id("bounties"),
    conversationId: v.id("conversations"),
    sourceTitle: v.string(),
    sourceBrief: v.string(),
    requirementsMarkdown: v.string(),
    acceptanceCriteria: v.array(v.object({
      id: v.string(),
      text: v.string(),
    })),
    openQuestions: v.array(v.string()),
    citationsJson: v.optional(v.string()),
    reviewScoreJson: v.optional(v.string()),
    llmProvider: v.string(),
    llmModel: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("generatedRequirements")
      .withIndex("by_bountyId", (q) => q.eq("bountyId", args.bountyId))
      .collect();
    const nextVersion = existing.reduce((max, row) => Math.max(max, row.version), 0) + 1;

    for (const row of existing) {
      if (row.status === "draft") {
        await ctx.db.patch(row._id, { status: "superseded" });
      }
    }

    return await ctx.db.insert("generatedRequirements", {
      bountyId: args.bountyId,
      conversationId: args.conversationId,
      version: nextVersion,
      sourceTitle: args.sourceTitle,
      sourceBrief: args.sourceBrief,
      requirementsMarkdown: args.requirementsMarkdown,
      acceptanceCriteria: args.acceptanceCriteria,
      openQuestions: args.openQuestions,
      citationsJson: args.citationsJson,
      reviewScoreJson: args.reviewScoreJson,
      status: "draft",
      llmProvider: args.llmProvider,
      llmModel: args.llmModel,
    });
  },
});

export const updateDraft = mutation({
  args: {
    generatedRequirementId: v.id("generatedRequirements"),
    requirementsMarkdown: v.string(),
  },
  handler: async (ctx, args) => {
    const user = requireAuth(await getCurrentUser(ctx));
    const generatedRequirement = await ctx.db.get(args.generatedRequirementId);
    if (!generatedRequirement) throw new Error("Generated requirements not found");

    const bounty = await ctx.db.get(generatedRequirement.bountyId);
    if (!bounty) throw new Error("Bounty not found");
    if (bounty.creatorId !== user._id && user.role !== "admin") {
      throw new Error("Unauthorized");
    }
    if (bounty.status !== "draft" && bounty.status !== "active") {
      throw new Error("Requirements cannot be modified after an agent has claimed the bounty");
    }

    await ctx.db.patch(args.generatedRequirementId, {
      requirementsMarkdown: args.requirementsMarkdown,
      acceptanceCriteria: extractAcceptanceCriteriaFromMarkdown(
        args.requirementsMarkdown,
        generatedRequirement.acceptanceCriteria,
      ),
      openQuestions: extractOpenQuestionsFromMarkdown(
        args.requirementsMarkdown,
        generatedRequirement.openQuestions,
      ),
      editedAt: Date.now(),
      citationsJson: markCitationsStale(generatedRequirement.citationsJson),
    });

    return args.generatedRequirementId;
  },
});

export const updateDraftInternal = internalMutation({
  args: {
    generatedRequirementId: v.id("generatedRequirements"),
    requirementsMarkdown: v.string(),
  },
  handler: async (ctx, args) => {
    const generatedRequirement = await ctx.db.get(args.generatedRequirementId);
    if (!generatedRequirement) throw new Error("Generated requirements not found");

    const bounty = await ctx.db.get(generatedRequirement.bountyId);
    if (!bounty) throw new Error("Bounty not found");
    if (bounty.status !== "draft" && bounty.status !== "active") {
      throw new Error("Requirements cannot be modified after an agent has claimed the bounty");
    }

    await ctx.db.patch(args.generatedRequirementId, {
      requirementsMarkdown: args.requirementsMarkdown,
      acceptanceCriteria: extractAcceptanceCriteriaFromMarkdown(
        args.requirementsMarkdown,
        generatedRequirement.acceptanceCriteria,
      ),
      openQuestions: extractOpenQuestionsFromMarkdown(
        args.requirementsMarkdown,
        generatedRequirement.openQuestions,
      ),
      editedAt: Date.now(),
      citationsJson: markCitationsStale(generatedRequirement.citationsJson),
    });

    return args.generatedRequirementId;
  },
});

export const approve = mutation({
  args: {
    generatedRequirementId: v.id("generatedRequirements"),
  },
  handler: async (ctx, args) => {
    const user = requireAuth(await getCurrentUser(ctx));
    const generatedRequirement = await ctx.db.get(args.generatedRequirementId);
    if (!generatedRequirement) throw new Error("Generated requirements not found");

    const bounty = await ctx.db.get(generatedRequirement.bountyId);
    if (!bounty) throw new Error("Bounty not found");
    if (bounty.creatorId !== user._id && user.role !== "admin") {
      throw new Error("Unauthorized");
    }

    const siblings = await ctx.db
      .query("generatedRequirements")
      .withIndex("by_bountyId", (q) => q.eq("bountyId", generatedRequirement.bountyId))
      .collect();
    for (const sibling of siblings) {
      if (sibling._id !== generatedRequirement._id && sibling.status === "approved") {
        await ctx.db.patch(sibling._id, { status: "superseded" });
      }
    }

    await ctx.db.patch(args.generatedRequirementId, {
      status: "approved",
      approvedAt: Date.now(),
    });
    await ctx.db.patch(generatedRequirement.bountyId, {
      description: generatedRequirement.requirementsMarkdown,
      creationStage: "tests",
    });

    return args.generatedRequirementId;
  },
});

export const approveInternal = internalMutation({
  args: {
    generatedRequirementId: v.id("generatedRequirements"),
  },
  handler: async (ctx, args) => {
    const generatedRequirement = await ctx.db.get(args.generatedRequirementId);
    if (!generatedRequirement) throw new Error("Generated requirements not found");

    const siblings = await ctx.db
      .query("generatedRequirements")
      .withIndex("by_bountyId", (q) => q.eq("bountyId", generatedRequirement.bountyId))
      .collect();
    for (const sibling of siblings) {
      if (sibling._id !== generatedRequirement._id && sibling.status === "approved") {
        await ctx.db.patch(sibling._id, { status: "superseded" });
      }
    }

    await ctx.db.patch(args.generatedRequirementId, {
      status: "approved",
      approvedAt: Date.now(),
    });
    await ctx.db.patch(generatedRequirement.bountyId, {
      description: generatedRequirement.requirementsMarkdown,
      creationStage: "tests",
    });

    return args.generatedRequirementId;
  },
});
