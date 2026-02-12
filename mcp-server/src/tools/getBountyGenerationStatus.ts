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
  } | null;
  testSuitesCount: number;
  overallReady: boolean;
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

        let text = `# Bounty Generation Status\n\n`;

        if (status.repoIndexing) {
          text += `## Repo Indexing\n`;
          text += `- **Status:** ${status.repoIndexing.status}\n`;
          if (status.repoIndexing.totalFiles) {
            text += `- **Files:** ${status.repoIndexing.totalFiles}\n`;
          }
          if (status.repoIndexing.languages?.length) {
            text += `- **Languages:** ${status.repoIndexing.languages.join(", ")}\n`;
          }
          if (status.repoIndexing.errorMessage) {
            text += `- **Error:** ${status.repoIndexing.errorMessage}\n`;
          }
        } else {
          text += `## Repo Indexing\nNo repository connected.\n`;
        }

        text += `\n`;

        if (status.conversation) {
          text += `## Conversation\n`;
          text += `- **Status:** ${status.conversation.status}\n`;
          text += `- **Autonomous:** ${status.conversation.autonomous ? "Yes" : "No"}\n`;
          text += `- **Messages:** ${status.conversation.messageCount}\n`;
        } else {
          text += `## Conversation\nNo conversation created.\n`;
        }

        text += `\n`;

        if (status.generatedTest) {
          text += `## Generated Tests\n`;
          text += `- **Status:** ${status.generatedTest.status}\n`;
          text += `- **Version:** ${status.generatedTest.version}\n`;
          text += `- **Framework:** ${status.generatedTest.testFramework}\n`;
          text += `- **Language:** ${status.generatedTest.testLanguage}\n`;
        } else {
          text += `## Generated Tests\nNot yet generated.\n`;
        }

        text += `\n`;
        text += `## Test Suites: ${status.testSuitesCount}\n\n`;
        text += `## Overall Ready: ${status.overallReady ? "YES" : "NO"}\n`;

        if (!status.overallReady) {
          text += `\nPipeline is still in progress. Poll again in a few seconds.`;
        }

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
