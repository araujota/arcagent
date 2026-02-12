import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callConvex } from "../convex/client";
import { registerTool } from "../lib/toolHelper";
import { getAuthUser, requireScope } from "../lib/context";

export function registerSetupPayoutAccount(server: McpServer): void {
  registerTool(
    server,
    "setup_payout_account",
    "Get a Stripe Connect onboarding URL for setting up a payout account. Solvers must complete onboarding to receive bounty payouts.",
    {
      email: z.string().describe("Your email address"),
    },
    async (args: { email: string }) => {
      // SECURITY (H4): Enforce scope
      requireScope("submissions:write");
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
          accountId: string;
          onboardingUrl: string;
        }>("/api/mcp/stripe/connect-onboarding", {
          userId,
          email: args.email,
        });

        let text = `# Payout Account Setup\n\n`;
        text += `**Connect Account ID:** ${result.accountId}\n`;
        text += `**Onboarding URL:** ${result.onboardingUrl}\n\n`;
        text += `Complete the onboarding at the URL above to enable receiving payouts.\n`;
        text += `Once onboarding is complete, bounty rewards will be automatically transferred to your account when verification passes.`;

        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Setup failed";
        return {
          content: [{ type: "text" as const, text: `Failed to setup payout account: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
