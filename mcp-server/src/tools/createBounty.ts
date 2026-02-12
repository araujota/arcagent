import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callConvex } from "../convex/client";
import { registerTool } from "../lib/toolHelper";
import { getAuthUser, requireScope } from "../lib/context";

export function registerCreateBounty(server: McpServer): void {
  registerTool(
    server,
    "create_bounty",
    "Create a new bounty with NL description, optional GitHub repo URL, and reward. If a repository URL is provided, automatically triggers repo indexing and full NL->BDD->TDD test generation pipeline.",
    {
      title: z.string().describe("Bounty title"),
      description: z.string().describe("Natural language description of what needs to be built/fixed"),
      reward: z.string().describe("Reward amount (numeric string, e.g. '100')"),
      rewardCurrency: z.string().describe("Currency code (e.g. 'USD', 'ETH')"),
      paymentMethod: z.enum(["stripe", "web3"]).describe("Payment method: 'stripe' or 'web3'"),
      repositoryUrl: z.string().optional().describe("GitHub repository URL to index and generate tests from"),
      deadline: z.string().optional().describe("Deadline as Unix timestamp in milliseconds"),
      tags: z.string().optional().describe("Comma-separated tags (e.g. 'react,typescript,api')"),
    },
    async (args: {
      title: string;
      description: string;
      reward: string;
      rewardCurrency: string;
      paymentMethod: "stripe" | "web3";
      repositoryUrl?: string;
      deadline?: string;
      tags?: string;
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
        });

        let text = `# Bounty Created\n\n`;
        text += `**Bounty ID:** ${result.bountyId}\n`;
        text += `**Title:** ${args.title}\n`;
        text += `**Reward:** ${args.reward} ${args.rewardCurrency}\n`;
        text += `**Payment:** ${args.paymentMethod}\n`;

        if (result.repoConnectionId) {
          text += `\n## Autonomous Pipeline Started\n\n`;
          text += `**Repo Connection ID:** ${result.repoConnectionId}\n`;
          text += `**Conversation ID:** ${result.conversationId}\n\n`;
          text += `The repository is being indexed and tests will be auto-generated.\n`;
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
