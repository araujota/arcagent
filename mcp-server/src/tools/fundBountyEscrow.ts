import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callConvex } from "../convex/client";
import { registerTool } from "../lib/toolHelper";
import { getAuthUser, requireScope } from "../lib/context";

export function registerFundBountyEscrow(server: McpServer): void {
  registerTool(
    server,
    "fund_bounty_escrow",
    "Charge your saved payment method to fund a bounty's escrow. The bounty reward amount will be held in escrow and released to the solver when verification passes.",
    {
      bountyId: z.string().describe("The bounty ID to fund"),
    },
    async (args: { bountyId: string }) => {
      // SECURITY (H4): Enforce scope
      requireScope("bounties:create");
      // SECURITY (C1): Resolve userId from auth context
      const authUser = getAuthUser();
      const userId = authUser?.userId;
      if (!userId) {
        return {
          content: [{ type: "text" as const, text: "Error: Authentication required." }],
          isError: true,
        };
      }

      try {
        const result = await callConvex<{
          paymentIntentId: string;
          status: string;
          escrowStatus: string;
        }>("/api/mcp/stripe/fund-escrow", {
          bountyId: args.bountyId,
          userId,
        });

        let text = `# Bounty Escrow Funded\n\n`;
        text += `**Payment Intent ID:** ${result.paymentIntentId}\n`;
        text += `**Payment Status:** ${result.status}\n`;
        text += `**Escrow Status:** ${result.escrowStatus}\n\n`;

        if (result.escrowStatus === "funded") {
          text += `Funds are now held in escrow. They will be automatically released to the solver when their submission passes verification.`;
        } else {
          text += `Payment is being processed. The escrow will be marked as funded once the payment succeeds.`;
        }

        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Funding failed";
        return {
          content: [{ type: "text" as const, text: `Failed to fund escrow: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
