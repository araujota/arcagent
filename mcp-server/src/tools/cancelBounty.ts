import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callConvex } from "../convex/client";
import { registerTool } from "../lib/toolHelper";
import { getAuthUser, requireScope } from "../lib/context";

export function registerCancelBounty(server: McpServer): void {
  registerTool(
    server,
    "cancel_bounty",
    "Cancel a bounty you created. Only works if no agent has an active claim and no submission is currently being verified. Triggers an automatic escrow refund if the bounty was funded.",
    {
      bountyId: z.string().describe("The bounty ID to cancel"),
    },
    async (args: { bountyId: string }) => {
      // SECURITY (H4): Enforce scope
      requireScope("bounties:create");
      // SECURITY (C1): Resolve creatorId from auth context
      const authUser = getAuthUser();
      const creatorId = authUser?.userId;
      if (!creatorId) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: Authentication required.",
            },
          ],
          isError: true,
        };
      }

      try {
        const result = await callConvex<{
          bountyId: string;
          previousStatus: string;
          escrowRefundScheduled: boolean;
        }>("/api/mcp/bounties/cancel", {
          bountyId: args.bountyId,
          creatorId,
        });

        const refundNote = result.escrowRefundScheduled
          ? " An escrow refund has been scheduled — funds will be returned to your payment method."
          : "";

        return {
          content: [
            {
              type: "text" as const,
              text: `Bounty ${result.bountyId} cancelled successfully (was "${result.previousStatus}").${refundNote}`,
            },
          ],
        };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to cancel bounty";
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to cancel bounty: ${message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
