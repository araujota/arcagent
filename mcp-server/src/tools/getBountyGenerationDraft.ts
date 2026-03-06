import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callConvex } from "../convex/client";
import { registerTool } from "../lib/toolHelper";
import { requireScope } from "../lib/context";

interface GenerationDraftResponse {
  bounty: {
    id: string;
    title: string;
    creationStage: string | null;
    commercialConfigPending: boolean;
  } | null;
  requirementsDraft: {
    id: string;
    status: string;
    version: number;
    requirementsMarkdown: string;
    acceptanceCriteria: Array<{ id: string; text: string }>;
    openQuestions: string[];
    citationsJson: string | null;
    reviewScoreJson: string | null;
    editedAt: number | null;
    approvedAt: number | null;
  } | null;
  testsDraft: {
    id: string;
    status: string;
    version: number;
    gherkinPublic: string;
    gherkinHidden: string;
    nativeTestFilesPublic: string | null;
    nativeTestFilesHidden: string | null;
    nativeTestsStale: boolean;
    testFramework: string;
    testLanguage: string;
    lastValidatedAt: number | null;
  } | null;
}

export function registerGetBountyGenerationDraft(server: McpServer): void {
  registerTool(
    server,
    "get_bounty_generation_draft",
    "Get the current staged bounty creation artifacts for a creator, including editable enhanced requirements and generated tests.",
    {
      bountyId: z.string().describe("The bounty ID to inspect"),
    },
    async (args: { bountyId: string }) => {
      requireScope("bounties:read");
      try {
        const draft = await callConvex<GenerationDraftResponse>(
          "/api/mcp/bounties/generation-draft",
          { bountyId: args.bountyId },
        );

        const sections = [
          "# Bounty Generation Draft",
          "",
          `**Bounty:** ${draft.bounty?.title ?? args.bountyId}`,
          `**Creation Stage:** ${draft.bounty?.creationStage ?? "n/a"}`,
          `**Commercial Terms Pending:** ${draft.bounty?.commercialConfigPending ? "Yes" : "No"}`,
          "",
        ];

        if (draft.requirementsDraft) {
          sections.push(
            "## Requirements Draft",
            `- **ID:** ${draft.requirementsDraft.id}`,
            `- **Status:** ${draft.requirementsDraft.status}`,
            `- **Version:** ${draft.requirementsDraft.version}`,
            `- **Acceptance Criteria:** ${draft.requirementsDraft.acceptanceCriteria.length}`,
            `- **Open Questions:** ${draft.requirementsDraft.openQuestions.length}`,
            "",
            "```md",
            draft.requirementsDraft.requirementsMarkdown,
            "```",
            "",
          );
        } else {
          sections.push("## Requirements Draft", "Not yet generated.", "");
        }

        if (draft.testsDraft) {
          sections.push(
            "## Generated Tests",
            `- **ID:** ${draft.testsDraft.id}`,
            `- **Status:** ${draft.testsDraft.status}`,
            `- **Version:** ${draft.testsDraft.version}`,
            `- **Framework:** ${draft.testsDraft.testFramework}`,
            `- **Language:** ${draft.testsDraft.testLanguage}`,
            `- **Native Tests Stale:** ${draft.testsDraft.nativeTestsStale ? "Yes" : "No"}`,
            "",
            "### Public Gherkin",
            "```gherkin",
            draft.testsDraft.gherkinPublic,
            "```",
            "",
            "### Hidden Gherkin",
            "```gherkin",
            draft.testsDraft.gherkinHidden,
            "```",
            "",
          );
          if (draft.testsDraft.nativeTestFilesPublic) {
            sections.push(
              "### Public Native Test Files",
              "```text",
              draft.testsDraft.nativeTestFilesPublic,
              "```",
              "",
            );
          }
          if (draft.testsDraft.nativeTestFilesHidden) {
            sections.push(
              "### Hidden Native Test Files",
              "```text",
              draft.testsDraft.nativeTestFilesHidden,
              "```",
              "",
            );
          }
        } else {
          sections.push("## Generated Tests", "Not yet generated.", "");
        }

        return { content: [{ type: "text" as const, text: sections.join("\n") }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to get generation draft";
        return {
          content: [{ type: "text" as const, text: `Failed to get bounty generation draft: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
