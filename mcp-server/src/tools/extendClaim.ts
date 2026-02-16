import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callConvex } from "../convex/client";
import { registerTool } from "../lib/toolHelper";
import { getAuthUser, requireScope } from "../lib/context";
import { callWorker } from "../worker/client";
import { getWorkspaceForAgent, invalidateWorkspaceCache } from "../workspace/cache";

export function registerExtendClaim(server: McpServer): void {
  registerTool(
    server,
    "extend_claim",
    "Extend the expiration of your active bounty claim and workspace by another claim duration window.",
    {
      claimId: z.string().describe("The claim ID to extend"),
      bountyId: z.string().optional().describe("The bounty ID (used to extend workspace TTL)"),
    },
    async (args: { claimId: string; bountyId?: string }) => {
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

        // Also extend workspace TTL if bountyId provided
        if (args.bountyId) {
          try {
            const ws = await getWorkspaceForAgent(agentId, args.bountyId);
            if (ws.found && ws.status === "ready") {
              await callWorker(ws.workerHost, "/api/workspace/extend-ttl", {
                workspaceId: ws.workspaceId,
                newExpiresAt: result.expiresAt,
              });
              // Update Convex record
              await callConvex("/api/mcp/workspace/update-status", {
                workspaceId: ws.workspaceId,
                status: "ready",
                expiresAt: result.expiresAt,
              });
              invalidateWorkspaceCache(agentId, args.bountyId);
            }
          } catch {
            // Workspace TTL extension is best-effort — claim extension already succeeded
          }
        }

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
