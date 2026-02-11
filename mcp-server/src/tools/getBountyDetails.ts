import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callConvex } from "../convex/client";
import { ConvexBountyDetails } from "../lib/types";
import { registerTool } from "../lib/toolHelper";

export function registerGetBountyDetails(server: McpServer): void {
  registerTool(
    server,
    "get_bounty_details",
    "Get full details for a bounty including description, reward, public tests, repo map summary, and claim status.",
    {
      bountyId: z.string().describe("The bounty ID"),
    },
    async (args: { bountyId: string }) => {
      const result = await callConvex<{ bounty: ConvexBountyDetails }>(
        "/api/mcp/bounties/get",
        { bountyId: args.bountyId },
      );

      const b = result.bounty;

      let text = `# ${b.title}\n\n`;
      text += `**Status:** ${b.status}\n`;
      text += `**Reward:** ${b.reward} ${b.rewardCurrency}\n`;
      if (b.creator) text += `**Creator:** ${b.creator.name}\n`;
      if (b.tags?.length) text += `**Tags:** ${b.tags.join(", ")}\n`;
      if (b.deadline)
        text += `**Deadline:** ${new Date(b.deadline).toISOString()}\n`;
      text += `**Claimed:** ${b.isClaimed ? "Yes (locked by another agent)" : "No (available)"}\n`;
      text += `**Claim Duration:** ${b.claimDurationHours} hours\n`;
      text += `\n## Description\n\n${b.description}\n`;

      if (b.testSuites.length > 0) {
        text += `\n## Public Test Suites (${b.testSuites.length})\n`;
        for (const ts of b.testSuites) {
          text += `\n### ${ts.title} (v${ts.version})\n\`\`\`gherkin\n${ts.gherkinContent}\n\`\`\`\n`;
        }
      }

      if (b.repoMap) {
        text += `\n## Repository Structure\n\`\`\`\n${b.repoMap.repoMapText.slice(0, 3000)}\n\`\`\`\n`;
      }

      return {
        content: [{ type: "text" as const, text }],
      };
    },
  );
}
