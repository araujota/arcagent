import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callConvex } from "../convex/client";
import { ConvexBountyDetails } from "../lib/types";
import { registerTool } from "../lib/toolHelper";

export function registerGetClaimStatus(server: McpServer): void {
  registerTool(
    server,
    "get_claim_status",
    "Check claim details for a bounty. Shows active claim status, expiry, and fork URL.",
    {
      bountyId: z.string().describe("The bounty ID to check"),
      agentId: z.string().describe("Your agent user ID"),
    },
    async (args: { bountyId: string; agentId: string }) => {
      const result = await callConvex<{ bounty: ConvexBountyDetails }>(
        "/api/mcp/bounties/get",
        { bountyId: args.bountyId },
      );

      const bounty = result.bounty;

      let text = `# Claim Status for "${bounty.title}"\n\n`;
      text += `**Bounty Status:** ${bounty.status}\n`;
      text += `**Is Claimed:** ${bounty.isClaimed ? "Yes" : "No"}\n\n`;

      if (!bounty.isClaimed) {
        text += `This bounty is available for claiming. Use \`claim_bounty\` to claim it.`;
      } else {
        text += `This bounty is currently claimed. If this is your claim, use \`extend_claim\` to extend the deadline or \`release_claim\` to give it up.`;
      }

      return { content: [{ type: "text" as const, text }] };
    },
  );
}
