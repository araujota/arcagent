import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callConvex } from "../convex/client";
import { registerTool } from "../lib/toolHelper";
import { getAuthUser, requireScope } from "../lib/context";
import { PLATFORM_TERMS_VERSION } from "../lib/legal";

export function registerCreateBounty(server: McpServer): void {
  registerTool(
    server,
    "create_bounty",
    "Create a new bounty with NL description, optional GitHub repo URL, and reward. If a repository URL is provided, ArcAgent starts repo indexing and staged requirements generation, then waits for creator approval before generating tests. Requires tosAccepted: true.",
    {
      title: z.string().describe("Bounty title"),
      description: z.string().describe("Natural language description of what needs to be built/fixed"),
      reward: z.string().describe("Reward amount (numeric string, e.g. '100')"),
      rewardCurrency: z.string().describe("Currency code (e.g. 'USD', 'ETH')"),
      paymentMethod: z.enum(["stripe", "web3"]).describe("Payment method: 'stripe' or 'web3'"),
      tosAccepted: z.boolean().describe("Must be true — confirms acceptance of ArcAgent's Terms of Service"),
      repositoryUrl: z.string().optional().describe("GitHub repository URL to index and generate tests from"),
      deadline: z.string().optional().describe("Deadline as Unix timestamp in milliseconds"),
      tags: z.string().optional().describe("Comma-separated tags (e.g. 'react,typescript,api')"),
      pmIssueKey: z.string().optional().describe("PM tool issue key (e.g. 'PROJ-123', 'LIN-456')"),
      pmProvider: z.enum(["jira", "linear", "asana", "monday"]).optional().describe("PM tool provider"),
    },
    async (args: {
      title: string;
      description: string;
      reward: string;
      rewardCurrency: string;
      paymentMethod: "stripe" | "web3";
      tosAccepted: boolean;
      repositoryUrl?: string;
      deadline?: string;
      tags?: string;
      pmIssueKey?: string;
      pmProvider?: "jira" | "linear" | "asana" | "monday";
    }) => {
      // SECURITY (H4): Enforce scope
      requireScope("bounties:create");
      // SECURITY (C1): Resolve creatorId from auth context
      const authUser = getAuthUser();
      const creatorId = authUser?.userId;
      if (!creatorId) {
        return {
          content: [{ type: "text" as const, text: "Error: Authentication required." }],
          isError: true,
        };
      }

      // Enforce TOS acceptance
      if (!args.tosAccepted) {
        return {
          content: [{ type: "text" as const, text: "Error: You must accept the ArcAgent Terms of Service (tosAccepted: true) to create a bounty." }],
          isError: true,
        };
      }

      try {
        const result = await callConvex<{
          bountyId: string;
          repoConnectionId: string | null;
          conversationId: string | null;
        }>("/api/mcp/bounties/create", {
          creatorId,
          title: args.title,
          description: args.description,
          reward: parseFloat(args.reward),
          rewardCurrency: args.rewardCurrency,
          paymentMethod: args.paymentMethod,
          repositoryUrl: args.repositoryUrl,
          deadline: args.deadline ? parseInt(args.deadline, 10) : undefined,
          tags: args.tags ? args.tags.split(",").map((t) => t.trim()) : undefined,
          tosAccepted: true,
          tosAcceptedAt: Date.now(),
          tosVersion: PLATFORM_TERMS_VERSION,
          pmIssueKey: args.pmIssueKey,
          pmProvider: args.pmProvider,
        });

        let text = `# Bounty Created\n\n`;
        text += `**Bounty ID:** ${result.bountyId}\n`;
        text += `**Title:** ${args.title}\n`;
        text += `**Reward:** ${args.reward} ${args.rewardCurrency}\n`;
        text += `**Payment:** ${args.paymentMethod}\n`;
        text += `**TOS:** Accepted (v${PLATFORM_TERMS_VERSION})\n`;
        if (args.paymentMethod === "stripe") {
          text += `**Status:** draft (fund escrow, then publish)\n`;
        }

        if (args.pmIssueKey) {
          text += `**PM Issue:** ${args.pmProvider}/${args.pmIssueKey}\n`;
        }

        if (result.repoConnectionId) {
          text += `\n## Staged Generation Started\n\n`;
          text += `**Repo Connection ID:** ${result.repoConnectionId}\n`;
          text += `**Conversation ID:** ${result.conversationId}\n\n`;
          text += `The repository is being indexed. Enhanced requirements will be generated next, and test generation will wait for approval.\n`;
          text += `Use \`get_bounty_generation_status\` with bounty ID \`${result.bountyId}\` to check progress.`;
        } else {
          text += `\nNo repository URL provided — bounty created without test generation pipeline.`;
        }

        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Bounty creation failed";
        return {
          content: [{ type: "text" as const, text: `Failed to create bounty: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
