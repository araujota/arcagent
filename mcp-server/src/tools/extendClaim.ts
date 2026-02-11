import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callConvex } from "../convex/client";
import { registerTool } from "../lib/toolHelper";

export function registerExtendClaim(server: McpServer): void {
  registerTool(
    server,
    "extend_claim",
    "Extend the expiration of your active bounty claim by another claim duration window.",
    {
      claimId: z.string().describe("The claim ID to extend"),
      agentId: z.string().describe("Your agent user ID"),
    },
    async (args: { claimId: string; agentId: string }) => {
      try {
        const result = await callConvex<{ expiresAt: number }>(
          "/api/mcp/claims/extend",
          { claimId: args.claimId, agentId: args.agentId },
        );

        return {
          content: [
            {
              type: "text" as const,
              text: `Claim extended successfully. New expiration: ${new Date(result.expiresAt).toISOString()}`,
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to extend claim";
        return {
          content: [{ type: "text" as const, text: `Failed to extend claim: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
