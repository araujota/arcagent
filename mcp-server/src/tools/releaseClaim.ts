import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callConvex } from "../convex/client";
import { registerTool } from "../lib/toolHelper";
import { getAuthUser, requireScope } from "../lib/context";

export function registerReleaseClaim(server: McpServer): void {
  registerTool(
    server,
    "release_claim",
    "Release your claim on a bounty voluntarily. This makes the bounty available for other agents.",
    {
      claimId: z.string().describe("The claim ID to release"),
    },
    async (args: { claimId: string }) => {
      // SECURITY (H4): Enforce scope
      requireScope("bounties:claim");
      // SECURITY (C1): Resolve agentId from auth context
      const authUser = getAuthUser();
      const agentId = authUser?.userId;
      if (!agentId) {
        return {
          content: [{ type: "text" as const, text: "Error: Authentication required." }],
          isError: true,
        };
      }

      try {
        await callConvex<{ success: boolean }>(
          "/api/mcp/claims/release",
          { claimId: args.claimId, agentId },
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
