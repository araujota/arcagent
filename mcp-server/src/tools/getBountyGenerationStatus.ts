import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callConvex } from "../convex/client";
import { registerTool } from "../lib/toolHelper";
import { requireScope } from "../lib/context";

interface GenerationStatus {
  repoIndexing: {
    status: string;
    totalFiles?: number;
    languages?: string[];
    errorMessage?: string;
  } | null;
  conversation: {
    status: string;
    autonomous?: boolean;
    messageCount: number;
  } | null;
  generatedTest: {
    status: string;
    version: number;
    testFramework: string;
    testLanguage: string;
    nativeTestsStale?: boolean;
  } | null;
  requirementsDraft: {
    status: string;
    version: number;
    acceptanceCriteriaCount: number;
    openQuestionsCount: number;
  } | null;
  testSuitesCount: number;
  creationStage: string | null;
  nextAction: string;
  publishReady: boolean;
  overallReady: boolean;
}

function renderRepoIndexing(status: GenerationStatus["repoIndexing"]): string {
  if (!status) {
    return "## Repo Indexing\nNo repository connected.\n";
  }

  const lines = [
    "## Repo Indexing",
    `- **Status:** ${status.status}`,
  ];
  if (status.totalFiles) {
    lines.push(`- **Files:** ${status.totalFiles}`);
  }
  if (status.languages?.length) {
    lines.push(`- **Languages:** ${status.languages.join(", ")}`);
  }
  if (status.errorMessage) {
    lines.push(`- **Error:** ${status.errorMessage}`);
  }
  return `${lines.join("\n")}\n`;
}

function renderConversation(status: GenerationStatus["conversation"]): string {
  if (!status) {
    return "## Conversation\nNo conversation created.\n";
  }

  return [
    "## Conversation",
    `- **Status:** ${status.status}`,
    `- **Autonomous:** ${status.autonomous ? "Yes" : "No"}`,
    `- **Messages:** ${status.messageCount}`,
    "",
  ].join("\n");
}

function renderGeneratedTests(status: GenerationStatus["generatedTest"]): string {
  if (!status) {
    return "## Generated Tests\nNot yet generated.\n";
  }

  return [
    "## Generated Tests",
    `- **Status:** ${status.status}`,
    `- **Version:** ${status.version}`,
    `- **Framework:** ${status.testFramework}`,
    `- **Language:** ${status.testLanguage}`,
    `- **Native Tests Stale:** ${status.nativeTestsStale ? "Yes" : "No"}`,
    "",
  ].join("\n");
}

function renderRequirementsDraft(status: GenerationStatus["requirementsDraft"]): string {
  if (!status) {
    return "## Requirements Draft\nNot yet generated.\n";
  }

  return [
    "## Requirements Draft",
    `- **Status:** ${status.status}`,
    `- **Version:** ${status.version}`,
    `- **Acceptance Criteria:** ${status.acceptanceCriteriaCount}`,
    `- **Open Questions:** ${status.openQuestionsCount}`,
    "",
  ].join("\n");
}

function renderOverallReady(overallReady: boolean): string {
  const lines = [`## Overall Ready: ${overallReady ? "YES" : "NO"}`];
  if (!overallReady) {
    lines.push("", "Pipeline is still in progress. Poll again in a few seconds.");
  }
  return `${lines.join("\n")}\n`;
}

export function registerGetBountyGenerationStatus(server: McpServer): void {
  registerTool(
    server,
    "get_bounty_generation_status",
    "Poll the status of repo indexing and test generation for a bounty. Returns repo indexing progress, conversation status, generated test status, and whether the bounty is fully ready.",
    {
      bountyId: z.string().describe("The bounty ID to check generation status for"),
    },
    async (args: { bountyId: string }) => {
      // SECURITY (H4): Enforce scope
      requireScope("bounties:read");
      try {
        const status = await callConvex<GenerationStatus>(
          "/api/mcp/bounties/generation-status",
          { bountyId: args.bountyId },
        );

        const text = [
          "# Bounty Generation Status",
          "",
          renderRepoIndexing(status.repoIndexing),
          renderConversation(status.conversation),
          renderRequirementsDraft(status.requirementsDraft),
          renderGeneratedTests(status.generatedTest),
          `## Test Suites: ${status.testSuitesCount}`,
          `## Creation Stage: ${status.creationStage ?? "n/a"}`,
          `## Next Action: ${status.nextAction}`,
          `## Publish Ready: ${status.publishReady ? "YES" : "NO"}`,
          "",
          renderOverallReady(status.overallReady),
        ].join("\n");

        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to get status";
        return {
          content: [{ type: "text" as const, text: `Failed to get generation status: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
