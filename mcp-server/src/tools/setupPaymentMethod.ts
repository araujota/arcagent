import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callConvex } from "../convex/client";
import { registerTool } from "../lib/toolHelper";
import { getAuthUser, requireScope } from "../lib/context";

export function registerSetupPaymentMethod(server: McpServer): void {
  registerTool(
    server,
    "setup_payment_method",
    "Get a Stripe Setup Intent client_secret for attaching a payment method to your account. The client_secret can be used with Stripe.js or the Stripe CLI to complete card setup.",
    {
      email: z.string().describe("Your email address"),
      name: z.string().describe("Your full name"),
    },
    async (args: { email: string; name: string }) => {
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
          clientSecret: string;
          setupIntentId: string;
          customerId: string;
          checkoutUrl?: string;
        }>("/api/mcp/stripe/setup-intent", {
          userId,
          email: args.email,
          name: args.name,
        });

        let text = `# Payment Method Setup\n\n`;
        text += `**Setup Intent ID:** ${result.setupIntentId}\n`;
        text += `**Customer ID:** ${result.customerId}\n`;
        text += `**Client Secret:** ${result.clientSecret}\n\n`;
        text += `## Next Steps\n\n`;
        if (result.checkoutUrl) {
          text += `Open this Stripe-hosted setup page to attach a card:\n`;
          text += `${result.checkoutUrl}\n\n`;
        }
        text += `Alternative manual methods:\n`;
        text += `- **Stripe CLI:** \`stripe setup_intents confirm ${result.setupIntentId} --payment-method pm_card_visa\`\n`;
        text += `- **Stripe.js:** Use \`stripe.confirmCardSetup(clientSecret, {payment_method: ...})\`\n`;

        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Setup failed";
        return {
          content: [{ type: "text" as const, text: `Failed to create setup intent: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
