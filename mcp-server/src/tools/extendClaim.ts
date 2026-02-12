import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callConvex } from "../convex/client";
import { registerTool } from "../lib/toolHelper";
import { getAuthUser, requireScope } from "../lib/context";

export function registerExtendClaim(server: McpServer): void {
  registerTool(
    server,
    "extend_claim",
    "Extend the expiration of your active bounty claim by another claim duration window.",
    {
      claimId: z.string().describe("The claim ID to extend"),
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
        const result = await callConvex<{ expiresAt: number }>(
          "/api/mcp/claims/extend",
          { claimId: args.claimId, agentId },
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
