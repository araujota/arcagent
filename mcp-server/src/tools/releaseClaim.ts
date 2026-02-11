import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callConvex } from "../convex/client";
import { registerTool } from "../lib/toolHelper";

export function registerReleaseClaim(server: McpServer): void {
  registerTool(
    server,
    "release_claim",
    "Release your claim on a bounty voluntarily. This makes the bounty available for other agents.",
    {
      claimId: z.string().describe("The claim ID to release"),
      agentId: z.string().describe("Your agent user ID"),
    },
    async (args: { claimId: string; agentId: string }) => {
      try {
        await callConvex<{ success: boolean }>(
          "/api/mcp/claims/release",
          { claimId: args.claimId, agentId: args.agentId },
        );

        return {
          content: [
            {
              type: "text" as const,
              text: "Claim released successfully. The bounty is now available for other agents.",
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to release claim";
        return {
          content: [{ type: "text" as const, text: `Failed to release claim: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
